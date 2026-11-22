import { batchInlineImagePages } from "@lotus-yunzai/skia/forward-images";
import type { CommandReply } from "./commands.ts";
import type { MessageEvent } from "./messages.ts";

type Scale = 4 | 2;
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

  let aggregate = 0;
  const high: Image[] = [];
  for (let page = 1; page <= total; page++) {
    const card = await image(page, 4);
    aggregate += card.file.byteLength;
    if (aggregate > limit) break;
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
      if (card.file.byteLength > limit) return "抽卡记录已读取，但单页图片仍超过当前会话的图片大小上限。";
      low.push(card);
    }
  }
  const batches = highBatches ?? batchInlineImagePages(low, inlineImageByteLimit, card => card.file.byteLength);
  if (!batches?.length) return "抽卡记录已读取，但单页图片仍超过当前会话的图片大小上限。";
  if (!await roleIsCurrent()) return signal.aborted ? undefined : changedRoleMessage;
  if (total === 1) return batches[0]?.[0];
  if (batches.length === 1) return { type: "forward", nodes: [title, ...batches[0]!] };
  if (!forward) return "当前会话无法分段合并转发抽卡记录。";

  for (const [index, pages] of batches.entries()) {
    if (index && !await roleIsCurrent()) return signal.aborted ? undefined : changedRoleMessage;
    try {
      if (!await forward([`${title}（第 ${index + 1}/${batches.length} 段）`, ...pages])) {
        return `第 ${index + 1} 段合并转发未发送，其余段落已停止。`;
      }
    } catch {
      return `第 ${index + 1} 段合并转发结果未确认，请在聊天中核对。`;
    }
  }
  return [];
}
