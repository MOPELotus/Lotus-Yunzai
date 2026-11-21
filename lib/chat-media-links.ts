import { readQqMessageImage, type IncomingChatFile } from "./chat-files.ts";
import { delegationSession } from "./command-delegation.ts";
import { sendCommandReply } from "./commands.ts";
import { isVerifiedRaster, type FileToUrl } from "./file-to-url.ts";
import type { InboundSegment, MessageEvent, MessageReply } from "./messages.ts";
import { maxPublicFileBytes } from "./public-files.ts";

const shareTime = 60_000;
const waitTime = 120_000;
const maxImages = 10;
const maxWaiting = 128;

interface Waiting {
  readonly expires: number;
  readonly signal: AbortSignal;
}

function imageParts(message: MessageEvent["message"]) {
  return typeof message === "string" ? [] : message.filter(part => part.type === "image");
}

export function createChatMediaLinks(publish: FileToUrl, httpReady: () => boolean) {
  const waits = new WeakMap<AbortSignal, Map<string, Waiting>>();

  return async (event: MessageEvent, workflow: () => AbortSignal, allowNew: boolean, admitted: () => boolean): Promise<boolean> => {
    const starts = /^#获?取直链$/u.test(event.msg);
    const connection = event[delegationSession]?.signal;
    if (!connection || connection.aborted || event.isDelegated || event.attachmentOnly ||
        (event.message_type !== "group" && (event.message_type !== "private" || event.sub_type !== "friend"))) return starts;
    const key = JSON.stringify([event.self_id, event.group_id, event.user_id]);
    const current = waits.get(connection);
    const previous = current?.get(key);
    const now = performance.now();
    const waiting = previous && !previous.signal.aborted && previous.expires > now ? previous : undefined;
    if (!starts && (!waiting || event.msg.startsWith("#") && event.msg !== "#取消取直链")) return false;
    const activeWorkflow = workflow();
    if (!admitted() || activeWorkflow.aborted) return starts;
    if (!starts && (event.msg === "取消" || event.msg === "#取消取直链")) {
      current?.delete(key);
      await event.reply("✅ 已取消");
      return true;
    }
    if (starts && !allowNew) return true;

    const signal = AbortSignal.any([connection, activeWorkflow, ...(waiting ? [waiting.signal] : [])]);
    const active = () => !signal.aborted && admitted();
    const reply = async (body: MessageReply, quote = false) => {
      if (active()) await event.reply(body, quote);
    };
    if (!httpReady()) {
      current?.delete(key);
      await reply("未启用公共 HTTP 服务，无法生成直链。", true);
      return true;
    }

    let images = imageParts(event.message);
    let file: IncomingChatFile | undefined = starts && event.canReadAttachments ? event.attachment : undefined;
    let fileIntended = starts && (file !== undefined || event.file?.type === "file");
    if (starts && event.reply_id !== undefined) {
      const quote = await event.lookupMediaReply?.(signal).catch(() => undefined);
      if (!active()) return true;
      if (!quote) {
        await reply("无法读取当前会话的引用消息。", true);
        return true;
      }
      const quotedImages = imageParts(quote.message);
      if (quote.message[0]?.type === "file") {
        file = quote.attachment;
        fileIntended = true;
      } else if (quotedImages.length) {
        file = undefined;
        fileIntended = false;
        images = quotedImages;
      }
    }

    if (fileIntended) {
      current?.delete(key);
      const data = await file?.read(signal).catch(() => undefined);
      if (!active()) return true;
      if (!data?.length || !file) {
        await reply("无法读取当前会话的附件。", true);
        return true;
      }
      const url = await publish(data, { name: file.name, mime: "application/octet-stream", time: shareTime }).catch(() => undefined);
      await reply(url ? `下载链接:\n${url}` : "暂时无法生成下载链接。", true);
      return true;
    }

    if (!images.length) {
      if (!starts) {
        if (event.msg) await reply("⚠ 请发送图片或取消");
        return true;
      }
      const queue = current ?? new Map<string, Waiting>();
      for (const [id, entry] of queue) if (entry.signal.aborted || entry.expires <= now) queue.delete(id);
      if (!queue.has(key) && queue.size >= maxWaiting) {
        await reply("暂时无法等待新图片，请稍后再试。");
        return true;
      }
      queue.set(key, { expires: now + waitTime, signal: activeWorkflow });
      waits.set(connection, queue);
      await reply("⚠ 请发送图片");
      return true;
    }

    current?.delete(key);
    const selected = starts ? images : images.slice(0, 1);
    if (selected.length > maxImages) {
      await reply(`一次最多处理 ${maxImages} 张图片。`, true);
      return true;
    }
    const available: { data: Uint8Array; summary?: string }[] = [];
    let bytes = 0;
    for (const image of selected) {
      if (!active()) return true;
      const data = await readQqMessageImage(image, signal);
      if (!data || (bytes += data.length) > maxPublicFileBytes || !await isVerifiedRaster(data)) {
        await reply("无法读取当前会话的图片或图片过大。", true);
        return true;
      }
      available.push({ data, summary: typeof image.summary === "string" ? image.summary : undefined });
    }
    if (!active()) return true;

    try {
      const nodes: MessageReply[] = [];
      for (const { data, summary } of available) {
        if (!active()) return true;
        const url = String(await publish(data, { time: shareTime }));
        if (!starts) {
          await reply(url);
          return true;
        }
        nodes.push([{ type: "image", file: url, ...(summary === undefined ? {} : { summary }) }, "\n", url]);
      }
      await reply(`✅ 检测到${nodes.length}张图片`);
      if (active() && nodes.length > 1) {
        await sendCommandReply(event, { type: "forward", nodes, senderName: "图片直链" });
      } else if (nodes[0]) await reply(nodes[0]);
    } catch {
      await reply("暂时无法生成下载链接。", true);
    }
    return true;
  };
}
