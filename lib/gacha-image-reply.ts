import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { nativeImageRasterScale } from "@lotus-yunzai/skia";
import type { CommandReply } from "./commands.ts";
import type { MessageEvent } from "./messages.ts";

type Scale = 4 | 2 | 1;
type Image = { readonly type: "image"; readonly file: Uint8Array };

interface GachaImageReplyOptions {
  readonly total: number;
  readonly title: string;
  readonly signal: AbortSignal;
  readonly forward?: MessageEvent["forward"];
  readonly render: (page: number, scale: Scale) => Promise<{ readonly png: Uint8Array }>;
  readonly verifyRole: () => Promise<boolean>;
  readonly changedRoleMessage: string;
}

export async function gachaImageReply({
  total, title, signal, forward, render, verifyRole, changedRoleMessage,
}: GachaImageReplyOptions): Promise<CommandReply | undefined> {
  const image = async (page: number, scale: Scale): Promise<Image> => {
    signal.throwIfAborted();
    const { png } = await render(page, scale);
    return { type: "image", file: png };
  };
  const roleIsCurrent = async () => !signal.aborted && await verifyRole() && !signal.aborted;
  const scale = nativeImageRasterScale();

  const high: Image[] = [];
  for (let page = 1; page <= total; page++) {
    const card = await image(page, scale);
    high.push(card);
  }
  const batches: Image[][] = [];
  for (let start = 0; start < high.length; start += 99) batches.push(high.slice(start, start + 99));
  if (!batches.length) return [];
  if (!await roleIsCurrent()) return signal.aborted ? undefined : changedRoleMessage;
  if (total === 1) return batches[0]?.[0];
  if (batches.length === 1 && !forward) return { type: "forward", nodes: [title, ...batches[0]!] };
  if (!forward) return $t("lib.gacha-image-reply.text_49c0fbd8bf");

  for (const [index, pages] of batches.entries()) {
    if (index && !await roleIsCurrent()) return signal.aborted ? undefined : changedRoleMessage;
    try {
      if (!await forward([batches.length === 1 ? title : $t("lib.gacha-image-reply.text_11d4132897", { "title": title, "value2": index + 1, "length": batches.length }), ...pages])) {
        return [];
      }
    } catch {
      return [];
    }
  }
  return [];
}
