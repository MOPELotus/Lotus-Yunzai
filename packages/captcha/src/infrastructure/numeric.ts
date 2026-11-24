export type Detection = { box: number[]; score: number; cls?: number }
const iou = (a: number[], b: number[]) => {
  const w = Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!)),
    h = Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!))
  return (
    (w * h) / Math.max(1, (a[2]! - a[0]!) * (a[3]! - a[1]!) + (b[2]! - b[0]!) * (b[3]! - b[1]!) - w * h)
  )
}
export function nms<T extends Detection>(rows: T[], threshold: number) {
  if (rows.some(row => row.box.length !== 4)) throw new Error('Invalid detection bounds')
  const sorted = [...rows].sort((a, b) => b.score - a.score),
    kept: T[] = []
  while (sorted.length) {
    const best = sorted.shift()!
    kept.push(best)
    for (let i = sorted.length - 1; i >= 0; i--)
      if (iou(best.box, sorted[i]!.box) >= threshold) sorted.splice(i, 1)
  }
  return kept
}
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>) {
  if (a.length !== b.length || !a.length) throw new Error('Invalid embedding dimensions')
  let dot = 0,
    aa = 0,
    bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    aa += a[i]! ** 2
    bb += b[i]! ** 2
  }
  return dot / Math.max(Number.EPSILON, Math.sqrt(aa * bb))
}
