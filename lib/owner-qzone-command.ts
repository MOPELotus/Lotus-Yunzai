import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { ownerAccountSession } from "./adapters/owner-account.ts";
import { qzoneSession, type QzonePost } from "./adapters/qzone.ts";
import { readQqMessageImage } from "./chat-files.ts";
import { isVerifiedRaster } from "./file-to-url.ts";
import { segment, type MessageEvent } from "./messages.ts";

export const ownerQzoneFeatures = [$t("lib.owner-qzone-command.text_2addde0474"), "group", "@lotus-yunzai/group"];
const listCommand = /^#获?取说说列表\s*(\d+)?$/u;
const deleteCommand = /^#删除?说说\s*(\d+)$/u;
const publishCommand = /^#发说说([\s\S]*)$/u;
const pageSize = 5;
const listLifetime = 10 * 60_000;
const maxMessages = 4096;
const maxImageBytes = 6 * 1024 * 1024;
const maxImageTotalBytes = 12 * 1024 * 1024;
const unsupported = $t("lib.owner-qzone-command.text_78d92ebf18");
const refreshList = $t("lib.owner-qzone-command.text_d4011a8620");
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
  return time > 0 && Number.isFinite(date.getTime()) ? dateFormat.format(date) : $t("lib.owner-qzone-command.text_664939a1fa");
}

function shorten(content: string) {
  const chars = [...content.replace(/\s+/gu, " ").trim()];
  return chars.length > 15 ? `${chars.slice(0, 12).join("")}...` : chars.join("");
}

function describe(post: QzonePost, index: number) {
  return $t("lib.owner-qzone-command.text_25a7bc1d1c", { "index": index, "value2": shorten(post.content), "value3": post.private ? $t("lib.owner-qzone-command.text_412677b5b7") : $t("lib.owner-qzone-command.text_7a73baf0ce"), "value4": postDate(post.time), "comments": post.comments });
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
      await event.reply($t("lib.owner-qzone-command.text_5b85f0a4c0"));
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
      await reply($t("lib.owner-qzone-command.text_f35af904df"));
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
      if (!await confirmFriend()) { await reply($t("lib.owner-qzone-command.text_8c4bae45bc")); return true; }
      if (!active()) return true;

      if (list) {
        views.delete(owner);
        const page = Number(list[1] ?? 1);
        const offset = (page - 1) * pageSize;
        if (page < 1 || !Number.isSafeInteger(offset + pageSize)) { await reply($t("lib.owner-qzone-command.text_aab46645f8")); return true; }
        const result = await readPage(offset);
        if (!result) { await reply($t("lib.owner-qzone-command.text_fee62ab595")); return true; }
        if (!result.posts.length) { await reply(offset === 0 ? $t("lib.owner-qzone-command.text_78957569c5") : $t("lib.owner-qzone-command.text_806ee0e930")); return true; }
        const pages = result.totalKnown ? `${page}/${Math.ceil(result.total / pageSize)}` : String(page);
        const description = result.posts.map((post, index) => describe(post, offset + index + 1)).join("\n");
        if (active()) await event.reply($t("lib.owner-qzone-command.text_511441181d", { "description": description, "pages": pages }), false, {
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
        if (selected.tid === undefined) { await reply($t("lib.owner-qzone-command.text_1995366d0a")); return true; }
        const current = await readPage(recent.offset);
        if (!current || current.posts[index]?.tid !== selected.tid) {
          views.delete(owner);
          await reply($t("lib.owner-qzone-command.text_e17b38a081"));
          return true;
        }
        if (!active() || !await confirmFriend() || !claimWrite()) return true;
        views.delete(owner);
        const receipt = await session.remove(selected.tid, signal);
        await reply(receipt.status === "confirmed" ? $t("lib.owner-qzone-command.text_97c4d15449", { "value1": describe(selected, position) }) : receipt.status === "unknown"
          ? $t("lib.owner-qzone-command.text_98044fe30e") : $t("lib.owner-qzone-command.text_14a380829b"));
        return true;
      }

      const content = publish![1]!.trim();
      const download = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      let parts = imageParts(event.message);
      if (!parts.length && event.reply_id !== undefined) {
        const quoted = await event.lookupMediaReply?.(download).catch(() => undefined);
        if (!quoted) { await reply($t("lib.owner-qzone-command.text_563c2493dc")); return true; }
        parts = imageParts(quoted.message);
      }
      if (!content && !parts.length) { await reply($t("lib.owner-qzone-command.text_333fa22afd")); return true; }
      if (parts.length > 9) { await reply($t("lib.owner-qzone-command.text_e1d0651e28")); return true; }
      let bytesLeft = maxImageTotalBytes;
      const images: Uint8Array[] = [];
      for (const part of parts) {
        const bytes = bytesLeft && await readQqMessageImage(part, download, {
          maxBytes: Math.min(bytesLeft, maxImageBytes), fallback: part.file,
        }).catch(() => undefined);
        if (!active()) return true;
        if (!bytes || !await isVerifiedRaster(bytes, 16_000_000, 4096)) {
          await reply($t("lib.owner-qzone-command.text_8407dcaf0b"));
          return true;
        }
        images.push(bytes);
        bytesLeft -= bytes.length;
      }
      if (!active() || (images.length && !await confirmFriend()) || !claimWrite()) return true;
      views.delete(owner);
      const receipt = await session.publish(content, images, signal);
      if (receipt.status === "confirmed") {
        const summary = $t("lib.owner-qzone-command.text_5c73c71e7d", { "value1": shorten(content) });
        const details = $t("lib.owner-qzone-command.text_c0d6d01c1f", { "value1": postDate(receipt.value.time) });
        await reply(images[0] ? [summary, segment.image(images[0]), details] : summary + details);
      } else await reply(receipt.status === "unknown" ? $t("lib.owner-qzone-command.text_b1c89914d5") : $t("lib.owner-qzone-command.text_4c0ad7b4c0"));
      return true;
    } finally {
      processing.delete(owner);
    }
  };
}
