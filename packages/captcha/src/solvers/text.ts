// Port of wulu's word posterior matcher and phrase ordering pipeline.
import * as ort from 'onnxruntime-node'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Puzzle, Answer, Solver, Point } from '../domain/puzzle.ts'
import { ModelPool } from '../infrastructure/models.ts'
import { detect } from '../infrastructure/detector.ts'
import { raster, cropImage, linearResize, type Raster, type Box } from '../infrastructure/image.ts'
import { PhraseLexicon } from './phrase-lexicon.ts'
import { cosine } from '../infrastructure/numeric.ts'
import { rootPath } from '../infrastructure/paths.ts'
function permutations(values: number[], count = values.length): number[][] {
  if (!count) return [[]]
  return values.flatMap((value, i) =>
    permutations(
      values.filter((_, j) => j !== i),
      count - 1,
    ).map((rest) => [value, ...rest]),
  )
}
async function recTensor(images: Raster[], minRatio: number) {
  const height = 48,
    width = Math.floor(height * Math.max(minRatio, ...images.map((i) => i.width / i.height)))
  const data = new Float32Array(images.length * 3 * height * width)
  for (let n = 0; n < images.length; n++) {
    const resizedWidth = Math.min(width, Math.ceil((height * images[n]!.width) / images[n]!.height)),
      resized = await linearResize(images[n]!, resizedWidth, height)
    for (let c = 0; c < 3; c++)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < resizedWidth; x++)
          data[n * 3 * height * width + c * height * width + y * width + x] =
            (resized.data[(y * resizedWidth + x) * 3 + (2 - c)]! / 255 - 0.5) / 0.5
  }
  return { tensor: new ort.Tensor('float32', data, [images.length, 3, height, width]), width }
}
async function posterior(models: ModelPool, images: Raster[]): Promise<Float32Array[]> {
  const model = await models.session('text-recognize'),
    features: Float32Array[] = []
  for (let start = 0; start < images.length; start += 8) {
    const chunk = images.slice(start, start + 8),
      { tensor, width } = await recTensor(chunk, 2),
      output = (await model.run({ [model.inputNames[0]!]: tensor }))[model.outputNames[0]!]!
    if (output.dims.length !== 3 || output.dims.some(value => value < 1)) throw new Error('Invalid text output dimensions')
    const steps = output.dims[1]!, classes = output.dims[2]!,
      data = output.data as Float32Array
    chunk.forEach((image, n) => {
      const frames = Math.min(
        steps,
        Math.max(1, Math.round(Math.min(width, Math.ceil((48 * image.width) / image.height)) / 8)),
      )
      let best = 0,
        bestScore = -Infinity
      for (let t = 0; t < frames; t++) {
        let score = 0
        for (let c = 1; c < classes; c++) score += data[(n * steps + t) * classes + c]!
        if (score > bestScore) {
          best = t
          bestScore = score
        }
      }
      features.push(data.slice((n * steps + best) * classes, (n * steps + best + 1) * classes))
    })
  }
  return features
}
export class WordSolver implements Solver {
  readonly id: string
  readonly kinds = ['click'] as const
  constructor(
    private readonly models: ModelPool,
    private readonly detectorId: 'word-detect' | 'phrase-detect' = 'word-detect',
  ) {
    this.id = detectorId === 'word-detect' ? 'click.text' : 'click.text.yolo26'
  }
  supports(p: Puzzle): boolean {
    return p.kind === 'click' && p.style === 'text'
  }
  async solve(puzzle: Puzzle): Promise<Answer> {
    if (puzzle.kind !== 'click' || !puzzle.prompts.length) throw new Error('Expected text prompts')
    const image = await raster(puzzle.image),
      boxes = await detect(this.models, this.detectorId, image, 0.4, 0.45, 5)
    if (boxes.length < puzzle.prompts.length) throw new Error('Insufficient character detections')
    const prompts = await Promise.all(puzzle.prompts.map(raster)),
      crops = boxes.map((b) => cropImage(image, b.x, b.y, b.width, b.height)),
      features = await posterior(this.models, [...prompts, ...crops])
    const candidates = permutations(
        boxes.map((_, i) => i),
        prompts.length,
      ),
      scores = candidates.map((order) =>
        order.reduce((sum, box, i) => sum + cosine(features[i]!, features[prompts.length + box]!), 0),
      )
    const order = candidates[scores.indexOf(Math.max(...scores))]!
    return {
      kind: 'points',
      points: order.map(
        (i) =>
          [
            (boxes[i]!.x + boxes[i]!.width / 2) / image.width,
            (boxes[i]!.y + boxes[i]!.height / 2) / image.height,
          ] as Point,
      ),
    }
  }
}
interface PhraseDictionary {
  table: Record<string, string>
  tried: Record<string, string[]>
  pending: Record<string, string>
}
function indices(chars: string[], phrase: string): number[] | undefined {
  if (phrase.length !== chars.length) return undefined
  const used: number[] = []
  for (const char of phrase) {
    const i = chars.findIndex((c, index) => c === char && !used.includes(index))
    if (i < 0) return
    used.push(i)
  }
  return used
}
export class PhraseSolver implements Solver {
  readonly id: string
  readonly kinds = ['click'] as const
  private lexicon?: Promise<PhraseLexicon>
  constructor(
    private readonly models: ModelPool,
    private readonly detectorId: 'word-detect' | 'phrase-detect' = 'phrase-detect',
    private readonly options: { lexicon?: boolean } = {},
  ) {
    this.id = options.lexicon
      ? 'click.phrase.lexicon'
      : detectorId === 'phrase-detect'
        ? 'click.phrase'
        : 'click.phrase.libreyolo'
  }
  supports(p: Puzzle): boolean {
    return p.kind === 'click' && p.style === 'phrase'
  }
  private async recognize(crops: Raster[]): Promise<string[]> {
    const model = await this.models.session('phrase-recognize'),
      { tensor } = await recTensor(crops, 320 / 48),
      result = (await model.run({ [model.inputNames[0]!]: tensor }))[model.outputNames[0]!]!
    const dict = JSON.parse(
      await fs.readFile(path.join(rootPath, 'resources/ocr-characters.json'), 'utf8'),
    ) as { character: string }
    const characters = ['blank', ...dict.character.split('\n'), ' '],
      steps = result.dims[1]!, classes = result.dims[2]!,
      values = result.data as Float32Array,
      chars: string[] = []
    if (result.dims.length !== 3 || result.dims.some(value => value < 1)) throw new Error('Invalid phrase output dimensions')
    for (let n = 0; n < crops.length; n++) {
      let previous = -1,
        text = ''
      for (let t = 0; t < steps; t++) {
        const offset = (n * steps + t) * classes
        let best = 0
        for (let c = 1; c < classes; c++) if (values[offset + c]! > values[offset + best]!) best = c
        if (best && best !== previous) text += characters[best]! || ''
        previous = best
      }
      chars.push(text.match(/[\u4e00-\u9fff]/)?.[0] || '')
    }
    return chars
  }
  private async order(chars: string[]): Promise<number[]> {
    const dictionary = await this.models.store.json<PhraseDictionary>('phrase-dictionary'),
      key = [...chars].sort().join('')
    const known =
      new Set(chars).size === chars.length && dictionary.table[key]!
        ? indices(chars, dictionary.table[key]!)
        : undefined
    if (known) return known
    if (this.options.lexicon) {
      this.lexicon ||= PhraseLexicon.load(this.models.store)
      const phrase = (await this.lexicon).unique(chars, dictionary.tried[key]! || [])
      const lexical = phrase ? indices(chars, phrase) : undefined
      if (lexical) return lexical
    }
    const tokenizer = await this.models.store.json<{ model: { vocab: Record<string, number> } }>(
        'phrase-tokens',
      ),
      vocabulary = tokenizer.model.vocab
    const ids = [
      vocabulary['[CLS]']!,
      ...chars.map((char) => vocabulary[char]! ?? vocabulary['[UNK]']!),
      vocabulary['[SEP]']!,
    ]
    const model = await this.models.session('phrase-order'),
      result = (
        await model.run({
          [model.inputNames[0]!]: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [
            1,
            ids.length,
          ]),
          [model.inputNames[1]!]: new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [
            1,
            ids.length,
          ]),
        })
      )[model.outputNames[0]!]!
    const data = result.data as Float32Array,
      classes = result.dims.at(-1)!,
      bad = new Set((dictionary.tried[key]! || []).map((p) => JSON.stringify(indices(chars, p))))
    const candidates = permutations(chars.map((_, i) => i))
      .filter((order) => !bad.has(JSON.stringify(order)))
      .map((order) => ({
        order,
        score: order.reduce(
          (sum, char, position) => sum + data[(char + 1) * classes + position]!,
          0,
        ),
      }))
      .sort((a, b) => b.score - a.score)
    const hint = indices(chars, dictionary.pending[key]! || '')
    return (
      (hint && candidates.some((p) => JSON.stringify(p.order) === JSON.stringify(hint))
        ? hint
        : candidates[0]!?.order) || chars.map((_, i) => i)
    )
  }
  async solve(puzzle: Puzzle): Promise<Answer> {
    if (puzzle.kind !== 'click') throw new Error('Expected phrase')
    const image = await raster(puzzle.image),
      boxes = await detect(this.models, this.detectorId, image, 0.7),
      crops = boxes.map((b) => cropImage(image, b.x, b.y, b.width, b.height))
    if (boxes.length !== 4) throw new Error('Phrase must have four detections')
    const chars = await this.recognize(crops)
    if (chars.some((c) => !c)) throw new Error('Phrase recognition failed')
    const order = await this.order(chars)
    return {
      kind: 'points',
      points: order.map(
        (i) =>
          [
            (boxes[i]!.x + boxes[i]!.width / 2) / image.width,
            (boxes[i]!.y + boxes[i]!.height / 2) / image.height,
          ] as Point,
      ),
    }
  }
}
