import type { FriendMessageNoticeSession } from "./friend-message-notice.ts";
import type { MessageEvent, MessageReply } from "./messages.ts";

export interface FriendRecallScope {
  readonly adapter: "onebot" | "milky";
  readonly botId: number;
  readonly userId: number;
  readonly messageId: number;
}

export interface GroupRecallScope extends FriendRecallScope {
  readonly groupId: number;
}

export interface NativeFriendRecallNotice extends FriendRecallScope, FriendMessageNoticeSession {
  readonly time: number;
}

export interface NativeGroupRecallNotice extends GroupRecallScope {
  readonly operatorId: number;
  readonly time: number;
  readonly signal: AbortSignal;
  describe(signal: AbortSignal): Promise<{ groupName?: string; nickname?: string; operatorName?: string }>;
  notifyOwners(summary: MessageReply, body: RecallBody, nickname: string | undefined, signal: AbortSignal): Promise<void>;
}

type RecallPart = string | { readonly type: "face"; readonly data: { readonly id: string | number; readonly is_large?: boolean } };
export type RecallBody = string | readonly RecallPart[];

interface RecallRecord {
  body?: RecallBody;
  readonly expires: number;
}

interface RecallStore {
  save(key: string, value: string, ttl: number): Promise<void>;
  take(key: string): Promise<string | null>;
}

const maxMessages = 4096;
const maxTextLength = 8192;
const maxParts = 128;

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function face(id: unknown, large: unknown): Exclude<RecallPart, string> | undefined {
  const value = typeof id === "string" && /^\d{1,16}$/u.test(id) ? Number(id) : id;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 ||
      (large !== undefined && typeof large !== "boolean")) return;
  return { type: "face", data: { id: value, ...(large === undefined ? {} : { is_large: large }) } };
}

export function readRecallBody(source: MessageEvent["message"]): RecallBody | undefined {
  if (typeof source === "string") return source;
  const parts: RecallPart[] = [];
  let hasFace = false;
  for (const part of source) {
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "face") {
      const formatted = face(part.id, part.is_large);
      if (!formatted) return;
      parts.push(formatted);
      hasFace = true;
    } else return;
  }
  if (!hasFace) return parts.join("");
  if (parts.length <= maxParts) return parts;
}

function copyRecallParts(parts: readonly unknown[], truncate: boolean): RecallPart[] | undefined {
  if (!parts.length || parts.length > maxParts) return;
  let remaining = maxTextLength;
  let hasFace = false;
  const copy: RecallPart[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (!truncate && part.length > remaining) return;
      const text = part.slice(0, remaining).toWellFormed();
      remaining -= text.length;
      if (text) copy.push(text);
      continue;
    }
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "face" || !("data" in part) ||
        !part.data || typeof part.data !== "object" || !("id" in part.data)) return;
    const formatted = face(part.data.id, "is_large" in part.data ? part.data.is_large : undefined);
    if (!formatted) return;
    copy.push(formatted);
    hasFace = true;
  }
  if (hasFace) return copy;
}

function messageKey(scope: FriendRecallScope | GroupRecallScope): string | undefined {
  const { adapter, botId, userId, messageId } = scope;
  if (!positiveId(botId) || !positiveId(userId) || botId === userId || !Number.isSafeInteger(messageId)) return;
  if (adapter === "milky" ? messageId < 0 : messageId === 0 || messageId < -2147483648 || messageId > 2147483647) return;
  if ("groupId" in scope) return positiveId(scope.groupId) ? `${adapter}:${botId}:${scope.groupId}:${userId}:${messageId}` : undefined;
  return `${adapter}:${botId}:${userId}:${messageId}`;
}

export function createMessageRecallCache(getStorage: () => RecallStore | undefined, now = Date.now) {
  const pending = new Map<string, Promise<void>>();
  const records = new Map<string, RecallRecord & { expiry: ReturnType<typeof setTimeout> }>();

  function remove(key: string) {
    const entry = records.get(key);
    if (entry) clearTimeout(entry.expiry);
    records.delete(key);
    return entry;
  }

  function scheduleExpiry(key: string, expires: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const entry = records.get(key);
      if (entry?.expires !== expires) return;
      if (expires <= now()) remove(key);
      else entry.expiry = scheduleExpiry(key, expires);
    }, Math.min(2_147_483_647, Math.max(1, expires - now())));
    timer.unref();
    return timer;
  }

  return {
    capture(scope: FriendRecallScope | GroupRecallScope, content: RecallBody, retention: () => Promise<number | undefined>, signal: AbortSignal) {
      const key = messageKey(scope);
      if (!key || signal.aborted) return;
      const body = typeof content === "string" ? content.slice(0, maxTextLength).toWellFormed() : copyRecallParts(content, true);
      if (!body || (typeof body === "string" && !body.trim())) return;
      const existing = pending.get(key);
      if (existing) return existing;
      if (pending.size >= maxMessages) return;
      const handling = (async () => {
        const ttl = await retention();
        if (signal.aborted || ttl === undefined || !Number.isSafeInteger(ttl) || ttl <= 0) return;
        const expires = now() + ttl * 1000;
        if (!Number.isSafeInteger(expires)) return;
        const storage = getStorage();
        if (storage) {
          const record = typeof body === "string" ? { text: body, expires } : { parts: body, expires };
          await storage.save(key, JSON.stringify(record), ttl);
        }
        else if ((records.get(key)?.expires ?? 0) <= now()) {
          remove(key);
          if (records.size >= maxMessages) remove(records.keys().next().value!);
          records.set(key, { body, expires, expiry: scheduleExpiry(key, expires) });
        }
      })().catch(() => {}).finally(() => pending.delete(key));
      pending.set(key, handling);
      return handling;
    },
    async take(scope: FriendRecallScope | GroupRecallScope, signal: AbortSignal): Promise<RecallBody | undefined> {
      const key = messageKey(scope);
      if (!key || signal.aborted) return;
      await pending.get(key);
      if (signal.aborted) return;
      const storage = getStorage();
      if (storage) {
        try {
          const saved = await storage.take(key);
          const entry: unknown = saved && JSON.parse(saved);
          if (signal.aborted || !entry || typeof entry !== "object" || !("expires" in entry) ||
              !positiveId(entry.expires) || entry.expires <= now()) return;
          if ("parts" in entry) return Array.isArray(entry.parts) ? copyRecallParts(entry.parts, false) : undefined;
          if ("text" in entry && typeof entry.text === "string" && entry.text.length <= maxTextLength) return entry.text;
        } catch { return; }
        return;
      }
      const entry = records.get(key);
      if (entry && entry.expires > now()) {
        const body = entry.body;
        delete entry.body;
        return body;
      }
    },
  };
}
