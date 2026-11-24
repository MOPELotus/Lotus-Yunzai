// Preserves the existing Pillow-compatible model preprocessing.
import sharp from 'sharp'
import * as ort from 'onnxruntime-node'
import { resizeRgb } from './resize.ts'
export async function imageTensor(
  image: Uint8Array,
  size: number,
  {
    normalize = false,
    crop = null,
    classifier = false,
    classifierJpegQuality = 75,
    flip = false,
  }: {
    normalize?: boolean
    crop?: { left: number; top: number; width: number; height: number } | null
    classifier?: boolean
    classifierJpegQuality?: number | null
    flip?: boolean
  } = {},
) {
  // PIL convert("RGB") discards alpha without compositing it onto white.
  let decoded = await sharp(Buffer.from(image))
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (crop) {
    const data = Buffer.alloc(crop.width * crop.height * 3),
      source = decoded
    // PIL crops truncate box coordinates and pad out-of-image pixels with black.
    const left = Math.max(0, crop.left),
      right = Math.min(source.info.width, crop.left + crop.width)
    if (right > left)
      for (
        let y = Math.max(0, crop.top);
        y < Math.min(source.info.height, crop.top + crop.height);
        y++
      ) {
        source.data.copy(
          data,
          ((y - crop.top) * crop.width + left - crop.left) * 3,
          (y * source.info.width + left) * 3,
          (y * source.info.width + right) * 3,
        )
      }
    decoded = { data, info: { ...source.info, width: crop.width, height: crop.height } }
  }
  if (flip) {
    const pixels = await sharp(decoded.data, {
      raw: { width: decoded.info.width, height: decoded.info.height, channels: 3 },
    })
      .flop()
      .raw()
      .toBuffer()
    decoded = { ...decoded, data: pixels }
  }
  // The reference classifier consumes JPEG crops (Pillow's default quality 75).
  // This round trip is significant for the tiny 40px target, not just storage.
  if (classifier && classifierJpegQuality !== null) {
    const jpeg = await sharp(decoded.data, {
      raw: { width: decoded.info.width, height: decoded.info.height, channels: 3 },
    })
      .jpeg({ quality: classifierJpegQuality, chromaSubsampling: '4:2:0' })
      .toBuffer()
    decoded = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
  }
  const w = decoded.info.width,
    h = decoded.info.height
  const width = classifier ? (w < h ? 232 : Math.floor((232 * w) / h)) : size
  const height = classifier ? (w < h ? Math.floor((232 * h) / w) : 232) : size
  const resized = resizeRgb(
    decoded.data,
    w,
    h,
    width,
    height,
    classifier ? 'cubic' : normalize ? 'lanczos3' : 'linear',
  )
  const outWidth = classifier ? 224 : width,
    outHeight = classifier ? 224 : height
  const pixels = outWidth * outHeight,
    values = new Float32Array(pixels * 3)
  const mean = [0.485, 0.456, 0.406],
    std = [0.229, 0.224, 0.225]
  for (let y = 0; y < outHeight; y++)
    for (let x = 0; x < outWidth; x++)
      for (let c = 0; c < 3; c++) {
        let value = Math.fround(resized[(y * width + x) * 3 + c]! / 255)
        if (normalize)
          value = classifier
            ? Math.fround(Math.fround(value - mean[c]!) / std[c]!)
            : Math.fround(Math.fround(value - Math.fround(mean[c]!)) / Math.fround(std[c]!))
        values[c * pixels + y * outWidth + x] = value
      }
  return new ort.Tensor('float32', values, [1, 3, outHeight, outWidth])
}
