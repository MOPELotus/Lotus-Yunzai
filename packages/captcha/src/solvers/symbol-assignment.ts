/** Exact one-to-one assignment; bounded to 12 detected candidates. */
export function symbolAssignment(scores: readonly (readonly number[])[]): number[] | undefined {
  if (
    !scores.length ||
    !scores[0]!.length ||
    scores.length > scores[0]!.length ||
    scores[0]!.length > 12 ||
    scores.some((row) => row.length !== scores[0]!.length || row.some((x) => !Number.isFinite(x)))
  )
    return
  let states = new Map<number, { score: number; columns: number[] }>([
    [0, { score: 0, columns: [] }],
  ])
  for (const row of scores) {
    const next = new Map<number, { score: number; columns: number[] }>()
    for (const [mask, state] of states)
      for (let column = 0; column < row.length; column++) {
        if (mask & (1 << column)) continue
        const key = mask | (1 << column),
          score = state.score + row[column]!
        if (!next.has(key) || next.get(key)!.score < score)
          next.set(key, { score, columns: [...state.columns, column] })
      }
    states = next
  }
  return [...states.values()].sort((a, b) => b.score - a.score)[0]!?.columns
}
