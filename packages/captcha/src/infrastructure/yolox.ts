// Port of ddddocr's MIT-licensed class-agnostic YOLOX detector preprocessing/decoding.
import * as ort from 'onnxruntime-node'
import { linearResize, suppress, type Raster, type Box } from './image.ts'
import { ModelPool } from './models.ts'
export async function yoloXInput(image: Raster) {
  const size = 416,
    scale = Math.min(size / image.width, size / image.height),
    w = Math.trunc(image.width * scale),
    h = Math.trunc(image.height * scale)
  const resized = await linearResize(image, w, h),
    data = new Float32Array(3 * size * size).fill(114)
  for (let c = 0; c < 3; c++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        data[c * size * size + y * size + x] = resized.data[(y * w + x) * 3 + 2 - c]!
  return { tensor: new ort.Tensor('float32', data, [1, 3, size, size]), scale }
}
export function decodeYoloX(
  data: ArrayLike<number>,
  channels: number,
  scale: number,
  width: number,
  height: number,
  confidence: number,
): Box[] {
  const boxes: Box[] = []
  let row = 0
  for (const stride of [8, 16, 32]) {
    const side = 416 / stride
    for (let gy = 0; gy < side; gy++)
      for (let gx = 0; gx < side; gx++, row++) {
        const offset = row * channels
        let best = 0,
          label = 0
        for (let c = 5; c < channels; c++)
          if (data[offset + c]! > best) {
            best = data[offset + c]!
            label = c - 5
          }
        const score = data[offset + 4]! * best
        if (score <= confidence) continue
        const x = ((data[offset]! + gx) * stride) / scale,
          y = ((data[offset + 1]! + gy) * stride) / scale,
          w = (Math.exp(data[offset + 2]!) * stride) / scale,
          h = (Math.exp(data[offset + 3]!) * stride) / scale
        const left = Math.max(0, x - w / 2),
          top = Math.max(0, y - h / 2),
          right = Math.min(width, x + w / 2),
          bottom = Math.min(height, y + h / 2)
        if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top)
          continue
        boxes.push({ x: left, y: top, width: right - left, height: bottom - top, score, label })
      }
  }
  return suppress(boxes, 0.45, 12)
}
export async function detectYoloX(
  models: ModelPool,
  id: string,
  image: Raster,
  confidence = 0.5,
): Promise<Box[]> {
  const model = await models.session(id),
    { tensor, scale } = await yoloXInput(image),
    output = (await model.run({ [model.inputNames[0]!]: tensor }))[model.outputNames[0]!]!
  if (output.dims.length !== 3 || output.dims[1]! !== 3549 || output.dims[2]! < 6)
    throw new Error('Invalid YOLOX output')
  return decodeYoloX(
    output.data as Float32Array,
    output.dims[2]!,
    scale,
    image.width,
    image.height,
    confidence,
  )
}
