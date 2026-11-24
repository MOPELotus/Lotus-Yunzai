import sharp from 'sharp'
import * as ort from 'onnxruntime-node'
import { vision } from './vision.ts'
export interface Raster {
  data: Uint8Array
  width: number
  height: number
}
export async function raster(image: Uint8Array): Promise<Raster> {
  const { data, info } = await sharp(Buffer.from(image))
    .flatten({ background: '#fff' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}
export function cropImage(
  image: Raster,
  left: number,
  top: number,
  width: number,
  height: number,
): Raster {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++)
    data.set(
      image.data.subarray(
        ((top + y) * image.width + left) * 3,
        ((top + y) * image.width + left + width) * 3,
      ),
      y * width * 3,
    )
  return { data, width, height }
}
export async function linearResize(image: Raster, width: number, height: number): Promise<Raster> {
  const cv = await vision(),
    src = cv.matFromArray(image.height, image.width, cv.CV_8UC3, image.data),
    dst = new cv.Mat()
  try {
    cv.resize(src, dst, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR)
    return { data: new Uint8Array(dst.data), width, height }
  } finally {
    src.delete()
    dst.delete()
  }
}
export async function letterbox(image: Raster, width: number, height: number) {
  const scale = Math.min(width / image.width, height / image.height),
    w = Math.round(image.width * scale),
    h = Math.round(image.height * scale)
  const padX = Math.floor((width - w) / 2),
    padY = Math.floor((height - h) / 2),
    resized = await linearResize(image, w, h)
  const values = new Float32Array(3 * width * height).fill(114 / 255)
  for (let c = 0; c < 3; c++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        values[c * width * height + (y + padY) * width + x + padX] =
          resized.data[(y * w + x) * 3 + c]! / 255
  return { tensor: new ort.Tensor('float32', values, [1, 3, height, width]), scale, padX, padY }
}
export interface Box {
  x: number
  y: number
  width: number
  height: number
  score: number
  label: number
}
export function suppress(boxes: Box[], threshold: number, limit = Infinity): Box[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score),
    kept: Box[] = []
  while (sorted.length && kept.length < limit) {
    const box = sorted.shift()!
    kept.push(box)
    for (let i = sorted.length - 1; i >= 0; i--) {
      const other = sorted[i]!,
        intersection =
          Math.max(
            0,
            Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x),
          ) *
          Math.max(
            0,
            Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y),
          )
      if (
        intersection /
          Math.max(1e-9, box.width * box.height + other.width * other.height - intersection) >
        threshold
      )
        sorted.splice(i, 1)
    }
  }
  return kept
}
