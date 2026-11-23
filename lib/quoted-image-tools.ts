import { readQqMessageImageSource } from "./chat-files.ts";
import { delegationSession } from "./command-delegation.ts";
import { isVerifiedRaster } from "./file-to-url.ts";
import type { MessageEvent, MessageReply, MessageSegment, RecallResult } from "./messages.ts";
import { maxPublicFileBytes } from "./public-files.ts";

const command = /^#?(链接|大小|过期)$/u;
const maxImages = 10;
const maxCommands = 2048;

export function createQuotedImageTools() {
  const refreshed = new WeakMap<AbortSignal, Set<string>>();

  return async function handle(event: MessageEvent, workflow: () => AbortSignal, admitted: () => boolean,
    recall: (active: () => boolean) => Promise<readonly RecallResult[] | string | undefined>): Promise<boolean> {
    const match = command.exec(event.msg.trim());
    if (!match || event.reply_id === undefined) return false;
    const connection = event[delegationSession]?.signal;
    if (!connection || event.isDelegated || event.attachmentOnly ||
        (event.message_type !== "group" && (event.message_type !== "private" || event.sub_type !== "friend"))) return false;

    const signal = AbortSignal.any([connection, workflow()]);
    const active = () => !signal.aborted && admitted();
    if (!active()) return true;
    const source = await event.lookupMediaReply?.(signal).catch(() => undefined);
    if (!active()) return true;
    if (!source) return false;
    const images = source.message.filter(part => part.type === "image");
    if (!images.length) return false;
    if (images.length > maxImages) {
      await event.reply(`一次最多处理 ${maxImages} 张图片。`, true);
      return true;
    }

    const retry = match[1] === "过期";
    if (retry) {
      if (event.message_id === undefined) {
        await event.reply("无法核实本次重发指令，原消息已保留。", true);
        return true;
      }
      const key = JSON.stringify([event.self_id, event.group_id, event.user_id, event.message_id]);
      const seen = refreshed.get(connection) ?? new Set<string>();
      if (seen.has(key)) return true;
      if (seen.size >= maxCommands) seen.delete(seen.values().next().value!);
      seen.add(key);
      refreshed.set(connection, seen);
    }

    const limit = Math.min(event.inlineImageByteLimit ?? maxPublicFileBytes, maxPublicFileBytes);
    let remaining = limit;
    const previews: { image: Extract<MessageSegment, { type: "image" }>; url: string; size: number }[] = [];
    for (const part of images) {
      if (!active()) return true;
      const loaded = remaining > 0 && await readQqMessageImageSource(part, signal, { maxBytes: remaining });
      if (!active()) return true;
      if (!loaded || !await isVerifiedRaster(loaded.data)) {
        if (active()) await event.reply("无法读取全部引用图片，或图片超过当前会话大小上限。", true);
        return true;
      }
      remaining -= loaded.data.byteLength;
      previews.push({ image: { type: "image", file: loaded.data }, url: loaded.url, size: loaded.data.byteLength });
    }
    if (!active()) return true;

    if (!retry) {
      const nodes: MessageReply[] = previews.map(({ image, url, size }, index) =>
        [`第 ${index + 1} 张 · ${size} 字节\n${url}\n`, image]);
      if (nodes.length === 1) await event.reply(nodes[0]!, true);
      else if (!event.forward || !await event.forward(nodes, "引用图片").catch(() => false)) {
        if (active()) await event.reply("图片合并转发未获确认。", true);
      }
      return true;
    }

    let confirmed = false;
    try {
      await event.reply(previews.map(({ image }) => image), false, { onDelivered() { confirmed = true; } });
    } catch { /* A transport error does not confirm delivery. */ }
    if (!active()) return true;
    if (!confirmed) {
      await event.reply("图片重发未获确认，原消息已保留。", true);
      return true;
    }
    const recalled = await recall(active).catch(() => undefined);
    if (!active()) return true;
    if (!Array.isArray(recalled) || recalled[0] !== "confirmed") {
      await event.reply(Array.isArray(recalled) && recalled[0] === "unknown"
        ? "图片已重发，原消息撤回结果未确认。"
        : "图片已重发，原消息未撤回。");
    } else if (recalled[1] && recalled[1] !== "confirmed") {
      await event.reply("原图消息已撤回，过期指令的撤回未获确认。");
    }
    return true;
  };
}
