// Ports the existing HGNet and public SigLIP matcher without training weights.
import sharp from 'sharp'
import * as ort from 'onnxruntime-node'
import type { Puzzle, Answer, Solver } from '../domain/puzzle.ts'
import { ModelPool } from '../infrastructure/models.ts'
import { imageTensor } from '../infrastructure/tensor.ts'
import { resizeRgb } from '../infrastructure/resize.ts'
type Grid = Extract<Puzzle, { kind: 'grid' }>

export class GridMatcher implements Solver {
  readonly id = 'grid.matcher'
  readonly kinds = ['grid'] as const
  constructor(private readonly models: ModelPool) {}
  supports(p: Puzzle): boolean {
    return p.kind === 'grid' && p.count !== undefined && p.prompts.length === 1
  }
  async solve(puzzle: Puzzle): Promise<Answer> {
    if (
      puzzle.kind !== 'grid' ||
      puzzle.count === undefined ||
      puzzle.count < 1 ||
      puzzle.count > puzzle.cells.length
    )
      throw new Error('Invalid grid')
    const logits = await this.scores(puzzle)
    const indices = Array.from(logits, (value, index) => ({ value, index }))
      .sort((a, b) => b.value - a.value)
      .slice(0, puzzle.count)
      .map((x) => x.index)
      .sort((a, b) => a - b)
    return { kind: 'grid', indices }
  }
  /** Raw pair scores; the caller must supply its own selection policy. */
  async scores(puzzle: Grid): Promise<Float32Array> {
    if (puzzle.prompts.length !== 1 || !puzzle.cells.length) throw new Error('Invalid grid')
    const backbone = await this.models.session('grid-vision'),
      head = await this.models.session('grid-head')
    const images = [...puzzle.prompts, ...puzzle.cells],
      size = 256,
      pixels = size * size
    const values = new Float32Array(images.length * 3 * pixels)
    for (let n = 0; n < images.length; n++) {
      const { data, info } = await sharp(Buffer.from(images[n]!))
        .flatten({ background: '#fff' })
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const rgb = resizeRgb(data, info.width, info.height, size, size, 'linear')
      for (let c = 0; c < 3; c++)
        for (let i = 0; i < pixels; i++)
          values[n * 3 * pixels + c * pixels + i] = Math.fround(
            (Math.fround(rgb[i * 3 + c]! / 255) - [0.485, 0.456, 0.406][c]!) /
              [0.229, 0.224, 0.225][c]!,
          )
    }
    // The backbone accepts a batch and returns per-image spatial features.
    const features = (
      await backbone.run({
        [backbone.inputNames[0]!]: new ort.Tensor('float32', values, [images.length, 3, size, size]),
      })
    )[backbone.outputNames[0]!]!
    const data = features.data as Float32Array,
      stride = data.length / images.length,
      count = puzzle.cells.length
    const prompts = new Float32Array(count * stride)
    for (let i = 0; i < count; i++) prompts.set(data.subarray(0, stride), i * stride)
    const shape = [count, ...features.dims.slice(1)]
    const logits = (
      await head.run({
        prompt_features: new ort.Tensor('float32', prompts, shape),
        cell_features: new ort.Tensor('float32', data.slice(stride), shape),
      })
    )[head.outputNames[0]!]!.data as Float32Array
    return logits
  }
}
export class GridClassifier implements Solver {
  readonly id: string
  readonly kinds = ['grid'] as const
  constructor(
    private readonly models: ModelPool,
    private readonly options: { emptyFallback?: boolean } = {},
  ) {
    this.id = options.emptyFallback ? 'grid.classifier.multiview' : 'grid.classifier'
  }
  supports(p: Puzzle): boolean {
    return (
      p.kind === 'grid' && p.count === undefined && p.prompts.length === 1 && p.cells.length === 9
    )
  }
  async solve(puzzle: Puzzle): Promise<Answer> {
    if (puzzle.kind !== 'grid') throw new Error('Expected grid')
    const baseline = await this.predict(puzzle, 75)
    if (baseline.length) return { kind: 'grid', indices: baseline }
    if (this.options.emptyFallback) {
      const alternatives = []
      for (const [quality, flip] of [
        [null, false],
        [90, false],
        [95, false],
        [null, true],
      ] as const)
        alternatives.push(await this.predict(puzzle, quality, flip))
      const agreed = agreeNonempty(alternatives)
      if (agreed) return { kind: 'grid', indices: agreed }
    }
    throw new Error('九宫格模型未识别到匹配项')
  }
  private async predict(puzzle: Grid, quality: number | null, flip = false): Promise<number[]> {
    const labels = await this.classify(puzzle, quality, flip)
    const target = labels.at(-1)
    return labels
      .slice(0, -1)
      .map((_, i) => i)
      .filter((i) => labels[i]! === target)
  }
  async classify(puzzle: Grid, quality: number | null = 75, flip = false): Promise<number[]> {
    const session = await this.models.session('hgnet'),
      images = [...puzzle.cells, ...puzzle.prompts]
    const tensors = await Promise.all(
      images.map((image) =>
        imageTensor(image, 224, {
          classifier: true,
          normalize: true,
          classifierJpegQuality: quality,
          flip,
        }),
      ),
    )
    const values = new Float32Array(tensors.length * tensors[0]!.data.length)
    tensors.forEach((tensor, i) => values.set(tensor.data as Float32Array, i * tensor.data.length))
    const result = (
      await session.run({
        [session.inputNames[0]!]: new ort.Tensor('float32', values, [images.length, 3, 224, 224]),
      })
    )[session.outputNames[0]!]!
    const data = result.data as Float32Array,
      classes = data.length / images.length
    const label = (row: number) => {
      let best = 0
      for (let i = 1; i < classes; i++)
        if (data[row * classes + i]! > data[row * classes + best]!) best = i
      return best
    }
    return images.map((_, i) => label(i))
  }
}

/** An empty/discordant view must never turn into an arbitrary click. */
export function agreeNonempty(views: readonly (readonly number[])[]): number[] | undefined {
  if (
    !views.length ||
    !views[0]!.length ||
    views.some(
      (view) => view.length !== views[0]!.length || view.some((index, i) => index !== views[0]![i]!),
    )
  )
    return undefined
  return [...views[0]!]
}
