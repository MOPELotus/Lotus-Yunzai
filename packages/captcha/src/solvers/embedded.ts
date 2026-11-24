// TypeScript port of the established paired-symbol recognizers.
import sharp from 'sharp'
import * as ort from 'onnxruntime-node'
import { imageTensor } from '../infrastructure/tensor.ts'
import { nms, cosine, type Detection } from '../infrastructure/numeric.ts'
import { ModelPool } from '../infrastructure/models.ts'
export class EmbeddedRecognition {
  constructor(readonly models: ModelPool) {}
  async locatePairs(image: Uint8Array, confidence = 0.4): Promise<(Detection & { cls: number })[]> {
    const session = await this.models.session('dfine'),
      meta = await sharp(Buffer.from(image)).metadata()
    const result = await session.run({
      [session.inputNames[0]!]: await imageTensor(image, 320),
      [session.inputNames[1]!]: new ort.Tensor(
        'int64',
        BigInt64Array.from([BigInt(meta.width!), BigInt(meta.height!)]),
        [1, 2],
      ),
    })
    if (!result.labels || !result.boxes || !result.scores) throw new Error('Invalid paired-symbol output')
    const labels = result.labels.data as BigInt64Array,
      boxes = result.boxes.data as Float32Array,
      scores = result.scores.data as Float32Array
    if (labels.length < scores.length || boxes.length !== scores.length * 4) throw new Error('Invalid paired-symbol dimensions')
    const rows: (Detection & { cls: number })[] = []
    for (let i = 0; i < scores.length; i++)
      if (scores[i]! > confidence)
        rows.push({
          box: Array.from(boxes.slice(i * 4, i * 4 + 4)),
          score: Number(scores[i]!),
          cls: Number(labels[i]!),
        })
    return rows
  }
  async dfine(image: Uint8Array) {
    const groups = new Map<number, Detection[]>()
    for (const { box, score, cls: label } of await this.locatePairs(image)) {
      if (box[2]! > 160 && box[3]! < 45) continue
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label)!.push({ box, score })
    }
    const pairs = [...groups.values()]
      .map((g) => nms(g, 0.01))
      .filter((g) => g.length >= 2 && g[0]!.score + g[1]!.score >= 0.85)
      .sort((a, b) => b[0]!.score + b[1]!.score - a[0]!.score - a[1]!.score)
      .slice(0, 3)
      .map((p) => p.slice(0, 2).sort((a, b) => b.box[3]! - a.box[3]!))
      .sort((a, b) => a[0]!.box[0]! - b[0]!.box[0]!)
    if (!pairs.length) throw new Error('图标模型未识别到匹配项')
    return pairs.map((pair) => {
      const b = pair[1]!.box
      return [
        Math.round(((b[0]! + b[2]!) / 2 / 333) * 10000),
        Math.round(((b[1]! + b[3]!) / 2 / 333) * 10000),
      ].join('_')
    })
  }
  async locateSymbols(image: Uint8Array, confidence = 0.5) {
    const detector = await this.models.session('embedded-detect'),
      meta = await sharp(Buffer.from(image)).metadata()
    const detected = await detector.run({ [detector.inputNames[0]!]: await imageTensor(image, 384) })
    const output = detected[detector.outputNames[0]!]!,
      dimensions = output.dims,
      count = dimensions[2]!,
      channels = dimensions[1]!,
      rows = []
    for (let i = 0; i < count; i++) {
      const at = (c: number) => Number(output.data[c * count + i]!)
      let cls = 0,
        score = at(4)
      for (let c = 5; c < channels; c++)
        if (at(c) > score) {
          cls = c - 4
          score = at(c)
        }
      if (score <= confidence) continue
      const box = [
        ((at(0) - at(2) / 2) / 384) * meta.width!,
        ((at(1) - at(3) / 2) / 384) * meta.height!,
        ((at(0) + at(2) / 2) / 384) * meta.width!,
        ((at(1) + at(3) / 2) / 384) * meta.height!,
      ]
      rows.push({ box, score, cls })
    }
    return nms(rows, 0.55)
  }
  async dino(image: Uint8Array) {
    const rows = await this.locateSymbols(image)
    const dino = await this.models.session('dino'),
      classify = await this.models.session('atten'),
      features: Record<'top' | 'bottom', (Detection & { feature: Float32Array })[]> = {
        top: [],
        bottom: [],
      }
    for (const row of rows) {
      const box = row.box.map(Math.trunc)
      if (box.length !== 4) throw new Error('Invalid symbol bounds')
      const left = box[0]!, top = box[1]!, right = box[2]!, bottom = box[3]!
      const width = right - left,
        height = bottom - top
      if (width <= 0 || height <= 0) continue
      const input = await imageTensor(image, 224, {
        normalize: true,
        crop: { left, top, width, height },
      })
      const tokens = (await dino.run({ [dino.inputNames[0]!]: input }))[dino.outputNames[0]!]!
      const patch = new ort.Tensor(
        'float32',
        (tokens.data as Float32Array).slice(5 * tokens.dims[2]!),
        [1, tokens.dims[1]! - 5, tokens.dims[2]!],
      )
      const feature = (await classify.run({ [classify.inputNames[0]!]: patch }))[
        classify.outputNames[0]!
      ]!.data as Float32Array
      features[row.cls === 0 ? 'top' : 'bottom']!.push({ ...row, box, feature })
    }
    if (!features.bottom.length || features.top.length < features.bottom.length)
      throw new Error('图标检测不完整')
    const used = new Set(),
      points = []
    for (const target of features.bottom.sort((a, b) => a.box[0]! - b.box[0]!)) {
      const candidates = features.top
        .map((row, index) => ({ ...row, index, similarity: cosine(target.feature, row.feature) }))
        .filter((row) => !used.has(row.index))
        .sort((a, b) => b.similarity - a.similarity)
      const best = candidates[0]!
      used.add(best.index)
      points.push(
        [
          Math.round(((best.box[0]! + best.box[2]!) / 2 / 333) * 10000),
          Math.round(((best.box[1]! + best.box[3]!) / 2 / 333) * 10000),
        ].join('_'),
      )
    }
    return points
  }
}
