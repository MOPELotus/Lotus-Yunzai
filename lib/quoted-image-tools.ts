import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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
      await event.reply($t("lib.quoted-image-tools.text_81c4fd171c", { "maxImages": maxImages }), true);
      return true;
    }

    const retry = match[1] === "过期";
    if (retry) {
      if (event.message_id === undefined) {
        await event.reply($t("lib.quoted-image-tools.text_8a414f51e9"), true);
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
        if (active()) await event.reply($t("lib.quoted-image-tools.text_946a53d2a1"), true);
        return true;
      }
      remaining -= loaded.data.byteLength;
      previews.push({ image: { type: "image", file: loaded.data }, url: loaded.url, size: loaded.data.byteLength });
    }
    if (!active()) return true;

    if (!retry) {
      const nodes: MessageReply[] = previews.map(({ image, url, size }, index) =>
        [$t("lib.quoted-image-tools.text_19bcdf3800", { "value1": index + 1, "size": size, "url": url }), image]);
      if (nodes.length === 1) await event.reply(nodes[0]!, true);
      else if (!event.forward || !await event.forward(nodes, $t("lib.quoted-image-tools.text_7b8eaa7fd1")).catch(() => false)) {
        if (active()) await event.reply($t("lib.quoted-image-tools.text_636389e4b7"), true);
      }
      return true;
    }

    let confirmed = false;
    try {
      await event.reply(previews.map(({ image }) => image), false, { onDelivered() { confirmed = true; } });
    } catch { /* A transport error does not confirm delivery. */ }
    if (!active()) return true;
    if (!confirmed) {
      await event.reply($t("lib.quoted-image-tools.text_30943ed1f7"), true);
      return true;
    }
    const recalled = await recall(active).catch(() => undefined);
    if (!active()) return true;
    if (!Array.isArray(recalled) || recalled[0] !== "confirmed") {
      await event.reply(Array.isArray(recalled) && recalled[0] === "unknown"
        ? $t("lib.quoted-image-tools.text_9d50babef0")
        : $t("lib.quoted-image-tools.text_dc66c0eb5b"));
    } else if (recalled[1] && recalled[1] !== "confirmed") {
      await event.reply($t("lib.quoted-image-tools.text_b2da0ff082"));
    }
    return true;
  };
}
