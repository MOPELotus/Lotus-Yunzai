/** Protocol-independent recognition input. Coordinates are normalized to images. */
export type Point = readonly [number, number]
export type Puzzle =
  | { kind: 'silent' }
  | { kind: 'grid'; cells: readonly Uint8Array[]; prompts: readonly Uint8Array[]; count?: number }
  | {
      kind: 'click'
      image: Uint8Array
      prompts: readonly Uint8Array[]
      style: 'symbols' | 'direction' | 'text' | 'phrase' | 'embedded-pairs' | 'embedded-similarity'
    }
  | { kind: 'slide'; background: Uint8Array; piece: Uint8Array; y: number }
  | { kind: 'match' | 'gomoku'; board: readonly (readonly number[])[] }
  | { kind: 'svg'; question: string; answers: Uint8Array }
  | { kind: 'voice'; audio: Uint8Array; language: string; templateVersion: string }
export type Answer =
  | { kind: 'silent' }
  | { kind: 'grid'; indices: readonly number[] }
  | { kind: 'points'; points: readonly Point[] }
  | { kind: 'slide'; offset: number }
  | { kind: 'board'; cells: readonly Point[] }
  | { kind: 'svg'; cell: Point; frame: number; columns: number; start: number; end: number }
  | { kind: 'text'; text: string }
export interface RecognitionContext {
  signal: AbortSignal
}
export interface Solver {
  readonly id: string
  readonly kinds: readonly Puzzle['kind'][]
  supports(puzzle: Puzzle): boolean
  solve(puzzle: Puzzle, context: RecognitionContext): Promise<Answer>
}
