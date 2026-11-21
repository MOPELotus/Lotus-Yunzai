import { readQqMessageImage } from "./chat-files.ts";
import { delegationSession } from "./command-delegation.ts";
import { isVerifiedRaster } from "./file-to-url.ts";
import { createLocalOcr, localOcrImageBytes } from "./local-ocr.ts";
import type { InboundSegment, MessageEvent } from "./messages.ts";

const maxOcrPixels = 12_000_000;
const maxOcrSide = 4096;
const ocrCommand = /^#(?:ocr|提?取文字)\s*$/iu;
const cancel = /^#?取消$/u;
const waitingTime = 120_000;
const maxPending = 500;

function firstImage(message: MessageEvent["message"] | undefined): InboundSegment | undefined {
  return Array.isArray(message) ? message.find(part => part.type === "image") : undefined;
}

export function createImageOcr() {
  const engine = createLocalOcr();
  let running = false;
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
    const connection = event[delegationSession]?.signal;
    const scope = `${event.group_id ?? "private"}:${event.user_id}`;
    const current = connection && pending.get(connection);
    const now = performance.now();
    const previous = current?.get(scope);
    const continuing = previous !== undefined && previous.expires > now && !previous.signal.aborted;
    if (previous && !continuing) current?.delete(scope);
    if (started ? !options.allowNew : !continuing || (!cancel.test(input) && /^[#/*%]/u.test(input))) return false;
    if (!connection) return false;
    const signal = AbortSignal.any([options.signal, connection]);
    const active = async () => !signal.aborted && await options.permitted() && !signal.aborted;
    if (!await active()) return true;
    if (!started && cancel.test(input)) {
      current?.delete(scope);
      await event.reply("已取消图片文字识别。", true);
      return true;
    }

    if (running) {
      await event.reply("图片文字识别正在处理，请稍后重试。", true);
      return true;
    }

    running = true;
    try {
      const engineState = await engine.prepare(signal);
      if (!await active()) return true;
      if (!engineState.ready) {
        await event.reply(engineState.failure, true);
        return true;
      }

      const transfer = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
      const quote = started && event.reply_id !== undefined ? await event.lookupMediaReply?.(transfer).catch(() => undefined) : undefined;
      const image = firstImage(quote?.message) ?? firstImage(event.message);
      if (!await active()) return true;
      if (!image) {
        if (started) {
          const scopes = pending.get(connection) ?? new Map();
          for (const [key, item] of scopes) if (item.expires <= now || item.signal.aborted) scopes.delete(key);
          scopes.delete(scope);
          if (scopes.size >= maxPending) scopes.delete(scopes.keys().next().value!);
          scopes.set(scope, { expires: now + waitingTime, signal: options.signal });
          pending.set(connection, scopes);
        }
        await event.reply("请发送图片或取消。", true);
        return true;
      }
      if (!started && !current?.delete(scope)) return true;
      if (started) pending.get(connection)?.delete(scope);
      const bytes = await readQqMessageImage(image, transfer, { maxBytes: localOcrImageBytes, fallback: image.file }).catch(() => undefined);
      if (!bytes || !await isVerifiedRaster(bytes, maxOcrPixels, maxOcrSide)) {
        if (await active()) await event.reply("无法读取这张图片，请重新发送。", true);
        return true;
      }
      if (!await active()) return true;
      const result = await engine.recognize(bytes, signal);
      if (await active()) await event.reply(result, true);
    } finally {
      running = false;
    }
    return true;
  };
}
