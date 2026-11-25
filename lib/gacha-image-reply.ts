import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import { batchInlineImagePages } from "@lotus-yunzai/skia/forward-images";
import type { CommandReply } from "./commands.ts";
import type { MessageEvent } from "./messages.ts";

type Scale = 4 | 2 | 1;
type Image = { readonly type: "image"; readonly file: Uint8Array };

interface GachaImageReplyOptions {
  readonly total: number;
  readonly title: string;
  readonly signal: AbortSignal;
  readonly inlineImageByteLimit?: number;
  readonly forward?: MessageEvent["forward"];
  readonly render: (page: number, scale: Scale) => Promise<{ readonly png: Uint8Array }>;
  readonly verifyRole: () => Promise<boolean>;
  readonly changedRoleMessage: string;
}

export async function gachaImageReply({
  total, title, signal, inlineImageByteLimit, forward, render, verifyRole, changedRoleMessage,
}: GachaImageReplyOptions): Promise<CommandReply | undefined> {
  const limit = inlineImageByteLimit ?? Infinity;
  const image = async (page: number, scale: Scale): Promise<Image> => {
    signal.throwIfAborted();
    const { png } = await render(page, scale);
    return { type: "image", file: png };
  };
  const roleIsCurrent = async () => !signal.aborted && await verifyRole() && !signal.aborted;
  const scale = nativeImageRasterScale();
  const tooLarge = $t("lib.gacha-image-reply.text_5b90ea75d3");

  let aggregate = 0;
  const high: Image[] = [];
  for (let page = 1; page <= total; page++) {
    const card = await image(page, scale);
    if (scale === 1 && card.file.byteLength > limit) return tooLarge;
    aggregate += card.file.byteLength;
    if (scale === 4 && aggregate > limit) break;
    high.push(card);
  }
  const highBatches = high.length === total ? batchInlineImagePages(high, inlineImageByteLimit, card => card.file.byteLength) : undefined;
  if (highBatches?.length === 1 || total === 0) {
    if (!await roleIsCurrent()) return signal.aborted ? undefined : changedRoleMessage;
    return total === 1 ? high[0] : { type: "forward", nodes: [title, ...high] };
  }

  // Byte overflow redraws the same pages at 2×. A nodes-only limit keeps 4× artwork.
  const lowerDensity = high.length !== total;
  if (lowerDensity) high.length = 0;
  const low: Image[] = [];
  if (lowerDensity) {
    for (let page = 1; page <= total; page++) {
      const card = await image(page, 2);
      if (card.file.byteLength > limit) return tooLarge;
      low.push(card);
    }
  }
  const batches = highBatches ?? batchInlineImagePages(low, inlineImageByteLimit, card => card.file.byteLength);
  if (!batches?.length) return tooLarge;
  if (!await roleIsCurrent()) return signal.aborted ? undefined : changedRoleMessage;
  if (total === 1) return batches[0]?.[0];
  if (batches.length === 1) return { type: "forward", nodes: [title, ...batches[0]!] };
  if (!forward) return $t("lib.gacha-image-reply.text_49c0fbd8bf");

  for (const [index, pages] of batches.entries()) {
    if (index && !await roleIsCurrent()) return signal.aborted ? undefined : changedRoleMessage;
    try {
      if (!await forward([$t("lib.gacha-image-reply.text_11d4132897", { "title": title, "value2": index + 1, "length": batches.length }), ...pages])) {
        return $t("lib.gacha-image-reply.text_0f1a420ea5", { "value1": index + 1 });
      }
    } catch {
      return $t("lib.gacha-image-reply.text_5af9e46976", { "value1": index + 1 });
    }
  }
  return [];
}
