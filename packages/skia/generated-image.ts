const generatedImages = new WeakSet<Uint8Array>();

/** 仅在绘图或编码新图片的生产点登记，保留原图或引用图的媒体数据。 */
export function markGeneratedImage<T extends Uint8Array>(image: T): T {
  generatedImages.add(image);
  return image;
}

export function isGeneratedImage(image: unknown): image is Uint8Array {
  return image instanceof Uint8Array && generatedImages.has(image);
}
