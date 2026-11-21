import { readQqMessageSegmentMedia } from "./chat-files.ts";
import { isVerifiedRaster } from "./file-to-url.ts";
import type { InboundSegment, MessageEvent } from "./messages.ts";

export const imageOcrSession = Symbol("imageOcrSession");
export const maxOcrImageBytes = 8 * 1024 * 1024;
export interface ImageOcrSession {
  readonly signal: AbortSignal;
  available(signal: AbortSignal): Promise<boolean>;
  recognize(image: Uint8Array, signal: AbortSignal): Promise<string | undefined>;
}

const ocrCommand = /^#(?:ocr|提?取文字)\s*$/iu;
const cancel = /^#?取消$/u;
const waitingTime = 120_000;
const maxPending = 500;

function firstImage(message: MessageEvent["message"] | undefined): InboundSegment | undefined {
  return Array.isArray(message) ? message.find(part => part.type === "image") : undefined;
}

export function createImageOcr() {
  const pending = new WeakMap<AbortSignal, Map<string, { expires: number; signal: AbortSignal }>>();
  return async (event: MessageEvent, options: {
    readonly allowNew: boolean;
    readonly signal: AbortSignal;
    permitted(): boolean | Promise<boolean>;
  }): Promise<boolean> => {
    if (event.isDelegated || event.attachmentOnly || event.attachment || event.user_id === undefined ||
        (event.isGroup ? event.group_id === undefined || event.sub_type === "anonymous" : event.sub_type !== "friend")) return false;
    const input = event.msg.trim();
    const started = ocrCommand.test(input);
    const session = event[imageOcrSession];
    const scope = `${event.group_id ?? "private"}:${event.user_id}`;
    const current = session && pending.get(session.signal);
    const now = performance.now();
    const previous = current?.get(scope);
    const continuing = previous !== undefined && previous.expires > now && !previous.signal.aborted;
    if (previous && !continuing) current?.delete(scope);
    if (started ? !options.allowNew : !continuing || (!cancel.test(input) && /^[#/*%]/u.test(input))) return false;
    const signal = session ? AbortSignal.any([options.signal, session.signal]) : options.signal;
    const active = async () => !signal.aborted && await options.permitted() && !signal.aborted;
    if (!await active()) return true;
    if (!session || (started && !await session.available(signal))) {
      if (await active()) await event.reply("当前协议端暂不支持图片文字识别。", true);
      return true;
    }
    if (!await active()) return true;
    if (!started && cancel.test(input)) {
      current?.delete(scope);
      await event.reply("已取消图片文字识别。", true);
      return true;
    }

    // An explicit command may switch to its own verified quote. Continuations only use the current message.
    const quoted = started && event.reply_id !== undefined ? await event.lookupReply?.().catch(() => undefined) : undefined;
    const image = firstImage(quoted?.message) ?? firstImage(event.message);
    if (!await active()) return true;
    if (!image) {
      if (started) {
        const scopes = pending.get(session.signal) ?? new Map();
        for (const [key, item] of scopes) if (item.expires <= now || item.signal.aborted) scopes.delete(key);
        // Delete before adding to keep insertion order meaningful when renewing a session.
        scopes.delete(scope);
        if (scopes.size >= maxPending) scopes.delete(scopes.keys().next().value!);
        scopes.set(scope, { expires: now + waitingTime, signal: options.signal });
        pending.set(session.signal, scopes);
      }
      await event.reply("请发送图片或取消。", true);
      return true;
    }
    if (!started && !current?.delete(scope)) return true;
    if (started) pending.get(session.signal)?.delete(scope);
    const bytes = await readQqMessageSegmentMedia(image, signal).catch(() => undefined);
    if (!bytes || bytes.byteLength > maxOcrImageBytes || !await isVerifiedRaster(bytes)) {
      if (await active()) await event.reply("无法读取这张图片，请重新发送。", true);
      return true;
    }
    if (!await active()) return true;
    const result = await session.recognize(bytes, signal);
    if (await active()) await event.reply(result ?? "图片文字识别失败，或当前协议端未提供此能力。", true);
    return true;
  };
}
