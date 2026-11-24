import type { Puzzle, Solver, Answer, Point } from '../domain/puzzle.ts'
export class SilentSolver implements Solver {
  readonly id = 'silent'
  readonly kinds = ['silent'] as const
  supports(p: Puzzle): boolean {
    return p.kind === 'silent'
  }
  async solve(): Promise<Answer> {
    return { kind: 'silent' }
  }
}
export class BoardSolver implements Solver {
  readonly id = 'board.rules'
  readonly kinds = ['match', 'gomoku'] as const
  supports(p: Puzzle): boolean {
    return p.kind === 'match' || p.kind === 'gomoku'
  }
  async solve(puzzle: Puzzle): Promise<Answer> {
    if (puzzle.kind !== 'match' && puzzle.kind !== 'gomoku') throw new Error('Expected board')
    const grid = puzzle.board.map((row) => [...row]),
      size = puzzle.kind === 'match' ? 3 : 5
    if (
      grid.length !== size ||
      grid.some((row) => row.length !== size || row.some((cell) => !Number.isInteger(cell)))
    )
      throw new Error('Invalid board')
    const wins = (): boolean => {
      const lines: number[][] = [...grid, ...grid.map((_, col) => grid.map((row) => row[col]!))]
      if (size === 5)
        lines.push(
          grid.map((row, i) => row[i]!),
          grid.map((row, i) => row[size - i - 1]!),
        )
      return lines.some(
        (line) => (size === 3 || line[0]! !== 0) && line.every((value) => value === line[0]!),
      )
    }
    const cells: Point[] = grid.flatMap((row, r) => row.map((_, c) => [r, c] as const))
    for (const [r, c] of cells)
      for (const [nr, nc] of puzzle.kind === 'match'
        ? [
            [r, c + 1],
            [r + 1, c],
          ]
        : cells.filter(([a, b]) => grid[a]![b]! === 0 && grid[r]![c]! !== 0)) {
        if (nr >= size || nc >= size) continue
        ;[grid[r]![c]!, grid[nr]![nc]!] = [grid[nr]![nc]!, grid[r]![c]!]
        try {
          if (wins())
            return {
              kind: 'board',
              cells: [
                [r, c],
                [nr, nc],
              ],
            }
        } finally {
          ;[grid[r]![c]!, grid[nr]![nc]!] = [grid[nr]![nc]!, grid[r]![c]!]
        }
      }
    throw new Error('No winning move')
  }
}
