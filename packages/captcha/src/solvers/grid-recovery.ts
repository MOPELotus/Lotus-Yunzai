import type { Puzzle, Answer, Solver } from '../domain/puzzle.ts'
import { ModelPool } from '../infrastructure/models.ts'
import { GridClassifier, GridMatcher } from './grid.ts'
/** Experimental fallback: infer the class, not a fixed cell count, from shared pair scores. */
export class GridSemanticRecovery implements Solver {
  readonly id = 'grid.classifier.semantic'
  readonly kinds = ['grid'] as const
  private readonly baseline: GridClassifier
  private readonly matcher: GridMatcher
  constructor(
    models: ModelPool,
    private readonly options: { minimumScore?: number; minimumMargin?: number } = {},
  ) {
    this.baseline = new GridClassifier(models, { emptyFallback: true })
    this.matcher = new GridMatcher(models)
  }
  supports(p: Puzzle): boolean {
    return this.baseline.supports(p)
  }
  async solve(puzzle: Puzzle): Promise<Answer> {
    if (puzzle.kind !== 'grid') throw new Error('Expected grid')
    try {
      return await this.baseline.solve(puzzle)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('未识别到匹配项')) throw error
    }
    const labels = (await this.baseline.classify(puzzle)).slice(0, -1)
    const scores = await this.matcher.scores(puzzle)
    const indices = groupedRecovery(
      labels,
      scores,
      this.options.minimumScore ?? 0,
      this.options.minimumMargin ?? 1.5,
    )
    if (!indices) throw new Error('No confident semantic grid recovery')
    return { kind: 'grid', indices }
  }
}
export function groupedRecovery(
  labels: readonly number[],
  scores: ArrayLike<number>,
  minimumScore: number,
  minimumMargin: number,
): number[] | undefined {
  if (!labels.length || labels.length !== scores.length) return
  const groups = new Map<number, number>()
  for (const [i, label] of labels.entries()) {
    if (!Number.isFinite(scores[i]!)) return
    groups.set(label, Math.max(groups.get(label) ?? -Infinity, scores[i]!))
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1]! - a[1]!)
  if (ranked[0]![1]! < minimumScore || ranked[0]![1]! - (ranked[1]!?.[1] ?? -Infinity) < minimumMargin)
    return
  return labels.map((_, i) => i).filter((i) => labels[i]! === ranked[0]![0]!)
}
