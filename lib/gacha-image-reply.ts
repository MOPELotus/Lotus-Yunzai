import type { CommandReply } from "./commands.ts";
import type { MessageEvent, MessageReply } from "./messages.ts";

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

const maxLimitedImagesPerForward = 99; // Milky 允许 100 个节点，其中一个节点是标题。

export async function gachaImageReply({
  total, title, signal, inlineImageByteLimit, forward, render, verifyRole, changedRoleMessage,
}: GachaImageReplyOptions): Promise<CommandReply | undefined> {
  const limit = inlineImageByteLimit ?? Infinity;
  const maxImages = inlineImageByteLimit === undefined ? Infinity : maxLimitedImagesPerForward;
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
  if (high.length === total && total <= maxImages) {
    if (!await roleIsCurrent()) return signal.aborted ? undefined : changedRoleMessage;
    return total === 1 ? high[0] : { type: "forward", nodes: [title, ...high] };
  }

  // Byte overflow redraws the same pages at 2×. A nodes-only limit keeps 4× artwork.
  const lowerDensity = high.length !== total;
  if (lowerDensity) high.length = 0;
  const batches: MessageReply[][] = [];
  let batch: MessageReply[] = [];
  let bytes = 0;
  for (let page = 1; page <= total; page++) {
    const card = lowerDensity ? await image(page, 2) : high[page - 1]!;
    const size = card.file.byteLength;
    if (size > limit) return "抽卡记录已读取，但单页图片仍超过当前会话的图片大小上限。";
    if (batch.length && (bytes + size > limit || batch.length >= maxImages)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(card);
    bytes += size;
  }
  batches.push(batch);
  if (!await roleIsCurrent()) return signal.aborted ? undefined : changedRoleMessage;
  if (total === 1) return batch[0];
  if (batches.length === 1) return { type: "forward", nodes: [title, ...batch] };
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
