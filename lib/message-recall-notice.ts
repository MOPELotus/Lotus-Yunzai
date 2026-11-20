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

export interface NativeGroupRecallSource extends GroupRecallScope {
  readonly message: MessageEvent["message"];
  readonly signal: AbortSignal;
}

export interface NativeFriendRecallNotice extends FriendRecallScope, FriendMessageNoticeSession {
  readonly time: number;
}

export interface NativeGroupRecallNotice extends GroupRecallScope {
  readonly operatorId: number;
  readonly time: number;
  readonly signal: AbortSignal;
  describe(signal: AbortSignal): Promise<{ groupName?: string; nickname?: string; operatorName?: string }>;
  notifyOwners(summary: MessageReply, text: string, nickname: string | undefined, signal: AbortSignal): Promise<void>;
}

interface RecallRecord {
  text?: string;
  readonly expires: number;
}

interface RecallStore {
  save(key: string, value: string, ttl: number): Promise<void>;
  take(key: string): Promise<string | null>;
}

const maxMessages = 4096;
const maxTextLength = 8192;

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
    capture(scope: FriendRecallScope | GroupRecallScope, text: string, retention: () => Promise<number | undefined>, signal: AbortSignal) {
      const key = messageKey(scope);
      if (!key || !text.trim() || signal.aborted) return;
      const existing = pending.get(key);
      if (existing) return existing;
      if (pending.size >= maxMessages) return;
      const handling = (async () => {
        const ttl = await retention();
        if (signal.aborted || ttl === undefined || !Number.isSafeInteger(ttl) || ttl <= 0) return;
        const expires = now() + ttl * 1000;
        if (!Number.isSafeInteger(expires)) return;
        const entry = { text: text.slice(0, maxTextLength).toWellFormed(), expires };
        const storage = getStorage();
        if (storage) await storage.save(key, JSON.stringify(entry), ttl);
        else if ((records.get(key)?.expires ?? 0) <= now()) {
          remove(key);
          if (records.size >= maxMessages) remove(records.keys().next().value!);
          records.set(key, { ...entry, expiry: scheduleExpiry(key, expires) });
        }
      })().catch(() => {}).finally(() => pending.delete(key));
      pending.set(key, handling);
      return handling;
    },
    async take(scope: FriendRecallScope | GroupRecallScope, signal: AbortSignal): Promise<string | undefined> {
      const key = messageKey(scope);
      if (!key || signal.aborted) return;
      await pending.get(key);
      if (signal.aborted) return;
      const storage = getStorage();
      if (storage) {
        try {
          const saved = await storage.take(key);
          const entry: unknown = saved && JSON.parse(saved);
          if (!signal.aborted && entry && typeof entry === "object" && "expires" in entry && positiveId(entry.expires) &&
              entry.expires > now() && "text" in entry && typeof entry.text === "string" && entry.text.length <= maxTextLength) return entry.text;
        } catch { return; }
        return;
      }
      const entry = records.get(key);
      if (entry && entry.expires > now()) {
        const text = entry.text;
        delete entry.text;
        return text;
      }
    },
  };
}
