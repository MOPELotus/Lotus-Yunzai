import fs from 'node:fs/promises'
import path from 'node:path'
import type { Raster, Box } from './image.ts'
import { letterbox, suppress } from './image.ts'
import { ModelPool } from './models.ts'
import { rootPath } from './paths.ts'
interface Metadata {
  custom: Record<string, string>
  inputs: { name: string; shape: (string | number)[] }[]
}
let metadata: Promise<Record<string, Metadata>> | undefined
export async function modelMetadata(id: string): Promise<Metadata> {
  metadata ||= fs
    .readFile(path.join(rootPath, 'resources/model-metadata.json'), 'utf8')
    .then((text) => JSON.parse(text) as Record<string, Metadata>)
  const entry = (await metadata)[id]!
  if (!entry) throw new Error(`Missing pinned metadata: ${id}`)
  return entry
}
export async function detect(
  models: ModelPool,
  id: string,
  image: Raster,
  confidence: number,
  iou = 0.45,
  limit = Infinity,
): Promise<Box[]> {
  const model = await models.session(id),
    meta = await modelMetadata(id),
    shape = meta.inputs[0]?.shape
  if (!shape || shape.length !== 4) throw new Error('Invalid model input dimensions')
  const width = typeof shape[3]! === 'number' ? shape[3]! : 320,
    height = typeof shape[2]! === 'number' ? shape[2]! : 320
  const { tensor, scale, padX, padY } = await letterbox(image, width, height)
  const output = (await model.run({ [model.inputNames[0]!]: tensor }))[model.outputNames[0]!]!,
    data = output.data as Float32Array
  const transposed = output.dims[1]! < output.dims[2]!,
    channels = transposed ? output.dims[1]! : output.dims[2]!,
    count = transposed ? output.dims[2]! : output.dims[1]!
  if (output.dims.length !== 3 || !Number.isInteger(channels) || channels < 5 || !Number.isInteger(count) || count < 1 || data.length !== channels * count) throw new Error('Invalid detection shape')
  const at = (n: number, c: number) => data[transposed ? c * count + n : n * channels + c]!,
    boxes: Box[] = []
  for (let n = 0; n < count; n++) {
    let score = at(n, 4),
      label = 0
    for (let c = 5; c < channels; c++)
      if (at(n, c) > score) {
        score = at(n, c)
        label = c - 4
      }
    if (score < confidence) continue
    const xyxy = meta.custom.box_format === 'xyxy',
      a = at(n, 0),
      b = at(n, 1),
      c = at(n, 2),
      d = at(n, 3)
    const clip = (n: number, max: number) => Math.max(0, Math.min(max, n))
    const x1 = clip(((xyxy ? a : a - c / 2) - padX) / scale, image.width),
      y1 = clip(((xyxy ? b : b - d / 2) - padY) / scale, image.height)
    const x2 = clip(((xyxy ? c : a + c / 2) - padX) / scale, image.width),
      y2 = clip(((xyxy ? d : b + d / 2) - padY) / scale, image.height)
    boxes.push({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, score, label })
  }
  return suppress(boxes, iou, limit)
    .map((box) => {
      const x = Math.trunc(box.x),
        y = Math.trunc(box.y)
      return {
        ...box,
        x,
        y,
        width: Math.trunc(box.x + box.width) - x,
        height: Math.trunc(box.y + box.height) - y,
      }
    })
    .filter((box) => box.width > 0 && box.height > 0)
}
