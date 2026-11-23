import { ownerAccountSession } from "./adapters/owner-account.ts";
import { qzoneSession, type QzonePost } from "./adapters/qzone.ts";
import { readQqMessageImage } from "./chat-files.ts";
import { isVerifiedRaster } from "./file-to-url.ts";
import { segment, type MessageEvent } from "./messages.ts";

export const ownerQzoneFeatures = ["[group] QQ 空间说说", "group", "@lotus-yunzai/group"];
const listCommand = /^#获?取说说列表\s*(\d+)?$/u;
const deleteCommand = /^#删除?说说\s*(\d+)$/u;
const publishCommand = /^#发说说([\s\S]*)$/u;
const pageSize = 5;
const listLifetime = 10 * 60_000;
const maxMessages = 4096;
const maxImageBytes = 6 * 1024 * 1024;
const maxImageTotalBytes = 12 * 1024 * 1024;
const unsupported = "当前协议端未确认支持 QQ 空间说说，需要支持空间说说的 NapCat。";
const refreshList = "请先获取包含该序号的说说列表，再使用 #删除说说 序号。";
const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

interface ListReceipt {
  readonly messageId: number;
  readonly offset: number;
  readonly posts: readonly QzonePost[];
  readonly expires: number;
}

function postDate(time: number) {
  const date = new Date(time * 1000);
  return time > 0 && Number.isFinite(date.getTime()) ? dateFormat.format(date) : "时间未知";
}

function shorten(content: string) {
  const chars = [...content.replace(/\s+/gu, " ").trim()];
  return chars.length > 15 ? `${chars.slice(0, 12).join("")}...` : chars.join("");
}

function describe(post: QzonePost, index: number) {
  return `${index}. ${shorten(post.content)}\n- [${post.private ? "私密" : "公开"}] | ${postDate(post.time)} | ${post.comments} 条评论`;
}

function imageParts(message: MessageEvent["message"] | undefined) {
  return Array.isArray(message) ? message.filter(part => part.type === "image") : [];
}

export function createOwnerQzoneCommand() {
  const receipts = new WeakMap<AbortSignal, Map<number, ListReceipt>>();
  const claimed = new Set<string>();
  const busy = new WeakMap<AbortSignal, Set<number>>();
  return async (event: MessageEvent, workflow: AbortSignal, allowed: () => boolean) => {
    const list = listCommand.exec(event.msg);
    const remove = deleteCommand.exec(event.msg);
    const publish = publishCommand.exec(event.msg);
    if (!list && !remove && !publish) return false;
    if (event.isDelegated || event.attachmentOnly || workflow.aborted || !allowed()) return true;
    const account = event[ownerAccountSession];
    if (event.message_type !== "private" || event.sub_type !== "friend" || !account?.isOwner() ||
        event.self_id === undefined || event.user_id === undefined || event.message_id === undefined) {
      await event.reply("只有当前机器人已绑定的主人可在好友私聊操作 QQ 空间说说。");
      return true;
    }
    const session = event[qzoneSession];
    if (!session) {
      if (!account.signal.aborted && allowed()) await event.reply(unsupported);
      return true;
    }
    const connection = session.signal;
    const signal = AbortSignal.any([connection, workflow]);
    const active = () => !signal.aborted && session.isOwner() && allowed();
    const reply = async (message: Parameters<MessageEvent["reply"]>[0]) => { if (active()) await event.reply(message); };
    if (!active()) return true;
    const owner = event.user_id;
    const processing = busy.get(connection) ?? new Set<number>();
    if (processing.has(owner)) {
      await reply("正在处理上一条说说指令，请稍后再试。");
      return true;
    }
    processing.add(owner);
    busy.set(connection, processing);
    const key = `${event.self_id}:${owner}:${event.message_id}`;
    const claimWrite = () => {
      if (!active() || claimed.has(key)) return false;
      if (claimed.size >= maxMessages) claimed.delete(claimed.values().next().value!);
      claimed.add(key);
      return true;
    };
    const confirmFriend = () => session.isFriend(signal).catch(() => false);
    const readPage = (offset: number) => session.list(offset, pageSize, signal).catch(() => undefined);
    const views = receipts.get(connection) ?? new Map<number, ListReceipt>();
    receipts.set(connection, views);
    try {
      if (claimed.has(key)) return true;
      if (!await session.supported(signal)) { await reply(unsupported); return true; }
      if (!active()) return true;
      if (!await confirmFriend()) { await reply("无法确认当前机器人的好友关系。"); return true; }
      if (!active()) return true;

      if (list) {
        views.delete(owner);
        const page = Number(list[1] ?? 1);
        const offset = (page - 1) * pageSize;
        if (page < 1 || !Number.isSafeInteger(offset + pageSize)) { await reply("请输入有效的说说列表页码。"); return true; }
        const result = await readPage(offset);
        if (!result) { await reply("无法读取说说列表，请确认当前 NapCat 支持该接口后重试。"); return true; }
        if (!result.posts.length) { await reply(offset === 0 ? "说说列表为空。" : "这页没有说说。"); return true; }
        const pages = result.totalKnown ? `${page}/${Math.ceil(result.total / pageSize)}` : String(page);
        const description = result.posts.map((post, index) => describe(post, offset + index + 1)).join("\n");
        if (active()) await event.reply(`说说列表\n${description}\n页数：${pages}`, false, {
          onDelivered(messageId) {
            if (active()) views.set(owner, { messageId, offset, posts: result.posts, expires: Date.now() + listLifetime });
          },
        });
        return true;
      }

      if (remove) {
        const position = Number(remove[1]);
        const recent = views.get(owner);
        if (!recent || recent.expires <= Date.now() || !Number.isSafeInteger(position) ||
            (event.reply_id !== undefined && String(event.reply_id) !== String(recent.messageId))) {
          await reply(refreshList);
          return true;
        }
        const index = position - recent.offset - 1;
        const selected = recent.posts[index];
        if (!selected) { await reply(refreshList); return true; }
        if (selected.tid === undefined) { await reply("协议端未返回这条说说的标识，无法安全删除。"); return true; }
        const current = await readPage(recent.offset);
        if (!current || current.posts[index]?.tid !== selected.tid) {
          views.delete(owner);
          await reply("说说列表位置发生变化或无法核对，请重新获取列表。");
          return true;
        }
        if (!active() || !await confirmFriend() || !claimWrite()) return true;
        views.delete(owner);
        const receipt = await session.remove(selected.tid, signal);
        await reply(receipt.status === "confirmed" ? `删除说说成功。\n${describe(selected, position)}` : receipt.status === "unknown"
          ? "删除结果未确认，请在 QQ 空间核对。" : "删除说说失败。");
        return true;
      }

      const content = publish![1]!.trim();
      const download = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      let parts = imageParts(event.message);
      if (!parts.length && event.reply_id !== undefined) {
        const quoted = await event.lookupMediaReply?.(download).catch(() => undefined);
        if (!quoted) { await reply("无法读取当前好友私聊引用的消息。"); return true; }
        parts = imageParts(quoted.message);
      }
      if (!content && !parts.length) { await reply("请填写说说正文，或发送要发布的图片。"); return true; }
      if (parts.length > 9) { await reply("一条说说最多可带 9 张图片。"); return true; }
      let bytesLeft = maxImageTotalBytes;
      const images: Uint8Array[] = [];
      for (const part of parts) {
        const bytes = bytesLeft && await readQqMessageImage(part, download, {
          maxBytes: Math.min(bytesLeft, maxImageBytes), fallback: part.file,
        }).catch(() => undefined);
        if (!active()) return true;
        if (!bytes || !await isVerifiedRaster(bytes, 16_000_000, 4096)) {
          await reply("无法读取说说图片，或图片尺寸、总大小超出限制。");
          return true;
        }
        images.push(bytes);
        bytesLeft -= bytes.length;
      }
      if (!active() || (images.length && !await confirmFriend()) || !claimWrite()) return true;
      views.delete(owner);
      const receipt = await session.publish(content, images, signal);
      if (receipt.status === "confirmed") {
        const summary = `发表说说成功。\n${shorten(content)}`;
        const details = `\n- [公开] | ${postDate(receipt.value.time)}`;
        await reply(images[0] ? [summary, segment.image(images[0]), details] : summary + details);
      } else await reply(receipt.status === "unknown" ? "发表结果未确认，请在 QQ 空间核对。" : "发表说说失败。");
      return true;
    } finally {
      processing.delete(owner);
    }
  };
}
