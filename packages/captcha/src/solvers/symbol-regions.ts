import sharp from 'sharp'
import { ModelPool } from '../infrastructure/models.ts'
import { raster, type Box } from '../infrastructure/image.ts'
import { nms } from '../infrastructure/numeric.ts'
import { detectYoloX } from '../infrastructure/yolox.ts'
import { EmbeddedRecognition } from './embedded.ts'
const roundEven = (value: number) => {
  const f = Math.floor(value)
  return value - f === 0.5 ? f + (f % 2) : Math.round(value)
}
/** Shared, protocol-independent symbol proposals after suppressing the dot-grid texture. */
export async function symbolRegions(models: ModelPool, bytes: Uint8Array, ensemble = true) {
  const clean = await sharp(Buffer.from(bytes)).blur(0.8).png().toBuffer(),
    image = await raster(clean),
    recognition = new EmbeddedRecognition(models),
    rows = await recognition.locateSymbols(clean, 0.3)
  if (ensemble)
    for (const b of await detectYoloX(models, 'symbol-detect', image))
      rows.push({ box: [b.x, b.y, b.x + b.width, b.y + b.height], score: b.score, cls: 0 })
  const boxes: Box[] = nms(rows, 0.35)
    .map((row) => {
      if (row.box.length !== 4) throw new Error('Invalid symbol bounds')
      const l = row.box[0]!, t = row.box[1]!, r = row.box[2]!, b = row.box[3]!,
        x = Math.max(0, roundEven(l)),
        y = Math.max(0, roundEven(t)),
        right = Math.min(image.width, roundEven(r)),
        bottom = Math.min(image.height, roundEven(b))
      return { x, y, width: right - x, height: bottom - y, score: row.score, label: 0 }
    })
    .filter(
      (b) =>
        b.width >= 12 && b.height >= 12 && b.width * b.height < image.width * image.height * 0.6,
    )
    .slice(0, 12)
  return { image, boxes }
}
