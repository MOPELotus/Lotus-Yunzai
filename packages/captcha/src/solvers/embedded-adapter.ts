import type { Puzzle, Solver, Answer } from '../domain/puzzle.ts'
import { EmbeddedRecognition } from './embedded.ts'
import { ModelPool } from '../infrastructure/models.ts'
export class EmbeddedClickSolver implements Solver {
  readonly kinds = ['click'] as const
  readonly id: string
  private readonly inference: EmbeddedRecognition
  constructor(
    models: ModelPool,
    readonly style: 'embedded-pairs' | 'embedded-similarity',
  ) {
    this.inference = new EmbeddedRecognition(models)
    this.id = `click.${style}`
  }
  supports(p: Puzzle): boolean {
    return p.kind === 'click' && p.style === this.style
  }
  async solve(puzzle: Puzzle): Promise<Answer> {
    if (puzzle.kind !== 'click') throw new Error('Expected click puzzle')
    const points =
      this.style === 'embedded-pairs'
        ? await this.inference.dfine(puzzle.image)
        : await this.inference.dino(puzzle.image)
    return {
      kind: 'points',
      points: points.map((point) => {
        const [x, y] = point.split('_').map(Number)
        if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid embedded point')
        return [x / 10000, y / 10000] as const
      }),
    }
  }
}
