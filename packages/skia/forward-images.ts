import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("skia", messageCatalog.messages);
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
  if (!forward) return $t("forward-images.text_c7d417d962");
  let index = 0;
  for await (const nodes of batches) {
    index++;
    if (beforeSend) {
      try { await beforeSend(); }
      catch { return $t("forward-images.text_f079e2df40"); }
    }
    try {
      if (!await forward(nodes)) return $t("forward-images.text_2922d95437", { "index": index });
    } catch {
      return $t("forward-images.text_822ee89ef3", { "index": index });
    }
  }
}
