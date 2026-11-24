export type InlineImage = { readonly type: "image"; readonly file: Uint8Array };
type ImageForwardNode = string | InlineImage;
type ImageForwardBatch = readonly ImageForwardNode[];

export interface BatchedImageForward<Batches = readonly ImageForwardBatch[]> {
  readonly type: "forward-image-batches";
  readonly batches: Batches;
  readonly beforeSend?: () => void | Promise<void>;
}

export type StreamedImageForward = BatchedImageForward<AsyncIterable<ImageForwardBatch>>;

// One node is reserved for the title in each bounded Milky forward.
const maximumImages = 99;

export function batchInlineImagePages<T>(pages: readonly T[], byteLimit: number | undefined, bytes: (page: T) => number) {
  const limit = byteLimit ?? Infinity;
  const count = byteLimit === undefined ? Infinity : maximumImages;
  const batches: T[][] = [];
  let total = 0;
  let batch: T[] = [];
  for (const page of pages) {
    const size = bytes(page);
    if (size > limit) return;
    if (batch.length && (total + size > limit || batch.length === count)) {
      batches.push(batch);
      batch = [];
      total = 0;
    }
    batch.push(page);
    total += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function sendBatchedImageForward({ batches, beforeSend }: BatchedImageForward | StreamedImageForward,
  forward?: (nodes: readonly ImageForwardNode[]) => Promise<boolean>) {
  if (!forward) return "当前会话无法分段合并转发图片。";
  let index = 0;
  for await (const nodes of batches) {
    index++;
    if (beforeSend) {
      try { await beforeSend(); }
      catch { return "会话或档案已变更，余下图片已停止发送。"; }
    }
    try {
      if (!await forward(nodes)) return `第 ${index} 段合并转发未发送，其余段落已停止。`;
    } catch {
      return `第 ${index} 段合并转发结果未确认，请在聊天中核对。`;
    }
  }
}
