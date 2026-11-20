import type { FriendMessageNoticeSession } from "./friend-message-notice.ts";
import { decodeChatFileBytes, maxChatFileBytes } from "./chat-files.ts";
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

type RecallFace = { readonly type: "face"; readonly data: { readonly id: string | number; readonly is_large?: boolean } };
type RecallImage = { readonly type: "image"; readonly file: Uint8Array };
type RecallPart = string | RecallFace | RecallImage;
export type RecallBody = string | readonly RecallPart[];

interface RecallRecord {
  body?: RecallBody;
  retainedBytes: number;
  readonly expires: number;
}

interface RecallStore {
  has?(key: string): Promise<boolean>;
  save(key: string, value: string, ttl: number, withImage: boolean): Promise<void>;
  take(key: string): Promise<string | null>;
}

const maxMessages = 4096;
const maxTextLength = 8192;
const maxParts = 128;
export const maxRecallImageCacheBytes = 64 * 1024 * 1024;
export const maxRecallImageCacheEntries = 1024;

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function face(id: unknown, large: unknown): RecallFace | undefined {
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

function copyRecallParts(parts: readonly unknown[], fromStorage: boolean): RecallPart[] | undefined {
  if (!parts.length || parts.length > maxParts) return;
  let remaining = maxTextLength;
  let imageBytes = 0;
  let hasSegment = false;
  const copy: RecallPart[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (fromStorage && part.length > remaining) return;
      const text = part.slice(0, remaining).toWellFormed();
      remaining -= text.length;
      if (text) copy.push(text);
      continue;
    }
    if (!part || typeof part !== "object" || !("type" in part)) return;
    if (part.type === "image") {
      const file = fromStorage
        ? ("bytes" in part ? decodeChatFileBytes(part.bytes) : undefined)
        : ("file" in part && part.file instanceof Uint8Array ? part.file : undefined);
      if (!file?.byteLength) return;
      imageBytes += file.byteLength;
      if (imageBytes > maxChatFileBytes) return;
      copy.push({ type: "image", file });
      hasSegment = true;
      continue;
    }
    if (part.type !== "face" || !("data" in part) ||
        !part.data || typeof part.data !== "object" || !("id" in part.data)) return;
    const formatted = face(part.data.id, "is_large" in part.data ? part.data.is_large : undefined);
    if (!formatted) return;
    copy.push(formatted);
    hasSegment = true;
  }
  if (hasSegment) return copy;
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
  let retainedImageBytes = 0;
  let retainedImages = 0;

  function releaseImageBudget(entry: RecallRecord) {
    if (entry.retainedBytes === 0) return;
    retainedImageBytes -= entry.retainedBytes;
    retainedImages--;
    entry.retainedBytes = 0;
  }

  function remove(key: string) {
    const entry = records.get(key);
    if (entry) {
      clearTimeout(entry.expiry);
      releaseImageBudget(entry);
    }
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
    capture(scope: FriendRecallScope | GroupRecallScope, content: RecallBody | (() => Promise<RecallBody | undefined>),
      retention: () => Promise<number | undefined>, signal: AbortSignal) {
      const key = messageKey(scope);
      if (!key || signal.aborted) return;
      const existing = pending.get(key);
      if (existing) return existing;
      if (pending.size >= maxMessages) return;
      const handling = (async () => {
        const ttl = await retention();
        if (signal.aborted || ttl === undefined || !Number.isSafeInteger(ttl) || ttl <= 0) return;
        const expires = now() + ttl * 1000;
        if (!Number.isSafeInteger(expires)) return;
        const storage = getStorage();
        if (typeof content === "function" && ((records.get(key)?.expires ?? 0) > now() || await storage?.has?.(key))) return;
        if (signal.aborted) return;
        const original = typeof content === "function" ? await content() : content;
        if (original === undefined || signal.aborted || expires <= now()) return;
        const body = typeof original === "string" ? original.slice(0, maxTextLength).toWellFormed() : copyRecallParts(original, false);
        if (!body || (typeof body === "string" && !body.trim())) return;
        const imageBytes = typeof body === "string" ? 0 : body.reduce((total, part) =>
          total + (typeof part !== "string" && part.type === "image" ? part.file.byteLength : 0), 0);
        if (storage) {
          const record = typeof body === "string" ? { text: body, expires } : { parts: body.map(part =>
            typeof part !== "string" && part.type === "image" ? { type: "image", bytes: Buffer.from(part.file).toString("base64") } : part), expires };
          await storage.save(key, JSON.stringify(record), Math.ceil((expires - now()) / 1000), imageBytes > 0);
        }
        else if ((records.get(key)?.expires ?? 0) <= now()) {
          remove(key);
          if (imageBytes && (retainedImages >= maxRecallImageCacheEntries ||
            retainedImageBytes + imageBytes > maxRecallImageCacheBytes)) return;
          if (records.size >= maxMessages) remove(records.keys().next().value!);
          records.set(key, { body, expires, retainedBytes: imageBytes, expiry: scheduleExpiry(key, expires) });
          if (imageBytes) {
            retainedImageBytes += imageBytes;
            retainedImages++;
          }
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
          if ("parts" in entry) return Array.isArray(entry.parts) ? copyRecallParts(entry.parts, true) : undefined;
          if ("text" in entry && typeof entry.text === "string" && entry.text.length <= maxTextLength) return entry.text;
        } catch { return; }
        return;
      }
      const entry = records.get(key);
      if (entry && entry.expires > now()) {
        const body = entry.body;
        delete entry.body;
        releaseImageBudget(entry);
        return body;
      }
    },
  };
}
