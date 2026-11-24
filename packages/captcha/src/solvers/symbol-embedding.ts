import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import type { Puzzle, Solver, Answer, RecognitionContext } from '../domain/puzzle.ts'
import { ModelPool } from '../infrastructure/models.ts'
import { raster, cropImage, type Raster } from '../infrastructure/image.ts'
import { resizeRgb } from '../infrastructure/resize.ts'
import { cosine } from '../infrastructure/numeric.ts'
import { symbolRegions } from './symbol-regions.ts'
import { symbolAssignment } from './symbol-assignment.ts'
/** The embedding model uses RGB /255, distinct from the detector's raw BGR. */
export function symbolEmbeddingInput(images: readonly Raster[]): ort.Tensor {
  if (!images.length) throw new Error('Empty symbol embedding batch')
  const size = 96,
    pixels = size * size,
    data = new Float32Array(images.length * 3 * pixels)
  for (const [n, image] of images.entries()) {
    const rgb = resizeRgb(image.data, image.width, image.height, size, size, 'linear')
    for (let c = 0; c < 3; c++)
      for (let i = 0; i < pixels; i++) data[n * 3 * pixels + c * pixels + i] = rgb[i * 3 + c]! / 255
  }
  return new ort.Tensor('float32', data, [images.length, 3, size, size])
}
/** Shared embedding model; ordered prompt-to-region matching is independent of protocol. */
export class SymbolEmbeddingSolver implements Solver {
  readonly id: string
  readonly kinds = ['click'] as const
  constructor(
    private readonly models: ModelPool,
    private readonly rotations: 1 | 4 | 12 = 1,
  ) {
    this.id = rotations === 1 ? 'click.symbols.embedding' : 'click.symbols.embedding.rotated'
  }
  supports(p: Puzzle): boolean {
    return p.kind === 'click' && p.style === 'symbols' && p.prompts.length > 0
  }
  async solve(puzzle: Puzzle, context?: RecognitionContext): Promise<Answer> {
    if (puzzle.kind !== 'click' || !puzzle.prompts.length || puzzle.prompts.length > 6)
      throw new Error('Expected ordered symbols')
    context?.signal.throwIfAborted()
    const { image, boxes } = await symbolRegions(this.models, puzzle.image)
    if (boxes.length < puzzle.prompts.length) throw new Error('Insufficient symbol detections')
    const prompts = []
    for (const bytes of puzzle.prompts)
      for (let angle = 0; angle < 360; angle += 360 / this.rotations)
        prompts.push(
          await raster(
            angle === 0
              ? bytes
              : await sharp(Buffer.from(bytes))
                  .flatten({ background: '#fff' })
                  .rotate(angle, { background: '#fff' })
                  .png()
                  .toBuffer(),
          ),
        )
    const images = [...prompts, ...boxes.map((b) => cropImage(image, b.x, b.y, b.width, b.height))]
    const model = await this.models.session('symbol-embedding'),
      output = (
        await model.run({
          [model.inputNames[0]!]: symbolEmbeddingInput(images),
        })
      )[model.outputNames[0]!]!,
      stride = output.data.length / images.length
    if (output.dims[0]! !== images.length || !Number.isInteger(stride))
      throw new Error('Invalid symbol embedding shape')
    const features = images.map((_, i) =>
      (output.data as Float32Array).subarray(i * stride, (i + 1) * stride),
    )
    const scores: number[][] = []
    for (let p = 0; p < puzzle.prompts.length; p++) {
      const row = boxes.map(() => -1)
      for (let r = 0; r < this.rotations; r++)
        for (let c = 0; c < boxes.length; c++)
          row[c] = Math.max(
            row[c]!,
            cosine(features[p * this.rotations + r]!, features[prompts.length + c]!),
          )
      scores.push(row)
    }
    const columns = symbolAssignment(scores)
    context?.signal.throwIfAborted()
    if (!columns || columns.some((column, i) => scores[i]![column]! < 0.3))
      throw new Error('No symbol embedding assignment')
    return {
      kind: 'points',
      points: columns.map(
        (i) =>
          [
            (boxes[i]!.x + boxes[i]!.width / 2) / image.width,
            (boxes[i]!.y + boxes[i]!.height / 2) / image.height,
          ] as const,
      ),
    }
  }
}
