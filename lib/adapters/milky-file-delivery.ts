import type { InboundSegment, MessageEvent } from "../messages.ts";
import { getMilkyFileCorrelation } from "./milky-message.ts";

const uploadGraceMs = 1_000;
const recentMs = 15_000;
const maxPending = 256;
const maxRecent = 4096;

interface FileKey {
  readonly user: number;
  readonly file: string;
  readonly hash?: string;
}

interface Pending {
  readonly key: FileKey;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Recent {
  readonly key: FileKey;
  readonly until: number;
  readonly source: "message" | "upload";
}

function fileKey(event: MessageEvent, segment: InboundSegment): FileKey | undefined {
  if (event.user_id === undefined || segment.type !== "file" || typeof segment.file !== "string") return;
  return { user: event.user_id, file: segment.file, hash: getMilkyFileCorrelation(segment) };
}

function matches(left: FileKey, right: FileKey): boolean {
  return left.user === right.user && left.file === right.file &&
    (left.hash === undefined || right.hash === undefined || left.hash === right.hash);
}

export function createMilkyFileDelivery(signal: AbortSignal, dispatch: (event: MessageEvent) => void) {
  const pending = new Set<Pending>();
  const recent = new Set<Recent>();
  const sequences = new Map<string, number>();

  function prune(now: number) {
    for (const item of recent) {
      if (item.until > now) break;
      recent.delete(item);
    }
    for (const [key, until] of sequences) {
      if (until > now) break;
      sequences.delete(key);
    }
  }

  function remember(key: FileKey, source: Recent["source"], now: number) {
    recent.add({ key, source, until: now + recentMs });
    if (recent.size > maxRecent) recent.delete(recent.values().next().value!);
  }

  function seen(key: FileKey, source?: Recent["source"]): boolean {
    for (const entry of recent) {
      if ((source === undefined || entry.source === source) && matches(entry.key, key)) return true;
    }
    return false;
  }

  signal.addEventListener("abort", () => {
    for (const { timer } of pending) clearTimeout(timer);
    pending.clear();
    recent.clear();
    sequences.clear();
  }, { once: true });

  return {
    upload(event: MessageEvent) {
      if (signal.aborted || !event.file) return;
      const key = fileKey(event, event.file);
      if (!key) return;
      prune(performance.now());
      if (pending.size >= maxPending || seen(key) ||
          [...pending].some((entry) => matches(entry.key, key))) return;

      const item: Pending = { key, timer: setTimeout(() => {
        pending.delete(item);
        if (signal.aborted) return;
        const now = performance.now();
        prune(now);
        if (seen(key)) return;
        remember(key, "upload", now);
        dispatch(event);
      }, uploadGraceMs) };
      item.timer.unref();
      pending.add(item);
    },
    receive(event: MessageEvent): boolean {
      if (!event.isPrivate || !event.file || !Array.isArray(event.message)) return true;
      const now = performance.now();
      prune(now);
      if (event.message_id !== undefined) {
        const key = `${event.user_id}:${event.message_id}`;
        if (sequences.has(key)) return false;
        sequences.set(key, now + recentMs);
        if (sequences.size > maxRecent) sequences.delete(sequences.keys().next().value!);
      }
      let alreadyDelivered = 0;
      for (const segment of event.message) {
        const key = fileKey(event, segment);
        if (!key) continue;
        for (const item of pending) {
          if (!matches(item.key, key)) continue;
          clearTimeout(item.timer);
          pending.delete(item);
        }
        if (seen(key, "upload")) alreadyDelivered++;
        else remember(key, "message", now);
      }
      return alreadyDelivered !== event.message.length;
    },
  };
}
