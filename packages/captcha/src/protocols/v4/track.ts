// TypeScript port of wulu's track builder/generators. See third-party notices.
import { gzipSync } from 'fflate'
import type { Point } from '../../domain/puzzle.ts'
export type PointerEvent = [number, number, number, number]
export interface Track {
  m: number
  w: number
  h: number
  s: number
  e: number
  p: PointerEvent[]
}
const uniform = (a: number, b: number) => a + Math.random() * (b - a)
export const integer = (a: number, b: number) => Math.floor(uniform(a, b + 1))
const rounded = (x: number) => Math.round(x * 10000) / 10000
const clip = (n: number) => Math.max(0, Math.min(1, n))
const jitter = ([x, y]: Point, amount: number): Point => [
  clip(x + uniform(-amount, amount)),
  clip(y + uniform(-amount, amount)),
]
export class TrackBuilder {
  readonly events: PointerEvent[]
  private current: Point
  constructor(start: Point) {
    this.current = start
    this.events = [[0, rounded(start[0]!), rounded(start[1]!), 0]]
  }
  down(): this {
    this.events.at(-1)![3] = 3
    return this
  }
  end(): this {
    this.events.at(-1)![3] = 2
    return this
  }
  move(target: Point, duration: number): this {
    const [x, y] = this.current,
      dx = target[0]! - x,
      dy = target[1]! - y,
      distance = Math.hypot(dx, dy)
    const offset = Math.min(0.2, Math.max(0.05, distance * 0.3)),
      angle1 = uniform(-Math.PI, Math.PI),
      angle2 = uniform(-Math.PI, Math.PI)
    const cp1: Point =
      distance < 0.01
        ? [x, y]
        : [
            x + dx * uniform(0.3, 0.7) + Math.cos(angle1) * offset * uniform(0.5, 1),
            y + dy * uniform(0.3, 0.7) + Math.sin(angle1) * offset * uniform(0.5, 1),
          ]
    const cp2: Point =
      distance < 0.01
        ? target
        : [
            target[0]! - dx * uniform(0.3, 0.7) + Math.cos(angle2) * offset * uniform(0.5, 1),
            target[1]! - dy * uniform(0.3, 0.7) + Math.sin(angle2) * offset * uniform(0.5, 1),
          ]
    const base = this.events.at(-1)![0]!
    for (let t = integer(17, 27); duration - t >= 17; t += integer(17, 27)) {
      const progress = t / duration,
        q = 3 * progress * progress - 2 * progress ** 3,
        inverse = 1 - q
      const at = (axis: number) =>
        inverse ** 3 * this.current[axis]! +
        3 * inverse ** 2 * q * cp1[axis]! +
        3 * inverse * q ** 2 * cp2[axis]! +
        q ** 3 * target[axis]!
      this.events.push([
        base + t,
        rounded(clip(at(0) + uniform(-0.002, 0.002))),
        rounded(clip(at(1) + uniform(-0.002, 0.002))),
        1,
      ])
    }
    this.events.push([base + duration, rounded(target[0]!), rounded(target[1]!), 1])
    this.current = target
    return this
  }
  click(delay = 90): this {
    this.down()
    const last = this.events.at(-1)!
    this.events.push([last[0]! + delay, last[1]!, last[2]!, 2])
    return this
  }
  build(): PointerEvent[] {
    if (this.events.length <= 150) return this.events
    const first = this.events[0]!,
      rest = this.events.slice(1),
      moves = rest.filter((p) => p[3]! === 1),
      actions = rest.filter((p) => p[3]! !== 1)
    if (actions.length >= 150) return [first, ...actions.slice(-149)]
    const need = 149 - actions.length,
      end = rest.at(-1)![0]!,
      near = moves.filter((p) => end - p[0]! <= 150)
    let selected = near.slice(-need)
    if (selected.length < need)
      selected = [
        ...moves.filter((p) => !near.includes(p)).slice(-(need - selected.length)),
        ...selected,
      ]
    return [first, ...selected, ...actions]
  }
}
const origin = (): Point => [uniform(0.4, 0.6), uniform(0.9, 1)]
const payload = (builder: TrackBuilder, height = 259.6015625): Track => {
  const p = builder.build(),
    s = Date.now()
  return { m: 1, w: 300.015625, h: height, s, e: s + p.at(-1)![0]!, p }
}
function sequence(
  targets: Point[],
  minimum = 2500,
  maximum = 4000,
): { track: Track; passtime: number } {
  if (!targets.length) throw new Error('Empty track targets')
  const delays = targets.map(() => integer(80, 120)),
    total = Math.max(1, integer(minimum, maximum) - delays.reduce((a, b) => a + b, 0))
  const weights = targets.map(() => Math.random()),
    sum = weights.reduce((a, b) => a + b, 0)
  const moves = weights.map((w) => Math.max(1, Math.floor((total * w) / sum)))
  moves[moves.length - 1] = Math.max(1, total - moves.slice(0, -1).reduce((a, b) => a + b, 0))
  const builder = new TrackBuilder(origin())
  targets.forEach((point, i) => builder.move(point, moves[i]!).click(delays[i]!))
  const track = payload(builder)
  return { track, passtime: track.p.at(-1)![0]! }
}
export function clickTrack(points: readonly Point[]) {
  return sequence([
    ...points.map(([x, y]) => jitter([(x * 300) / 300.015625, (y * 200) / 259.6015625], 0.02)),
    jitter([0.5, 0.92], 0.01),
  ])
}
export function gridTrack(indices: readonly number[], columns = 3) {
  return sequence(
    indices.map((index) =>
      jitter(
        [((index % columns) + 0.5) / columns, (Math.floor(index / columns) + 0.5) / columns],
        0.05,
      ),
    ),
  )
}
export function boardTrack(cells: readonly Point[], gomoku: boolean) {
  return sequence(
    cells.map(([a, b]) =>
      jitter(
        gomoku
          ? [(20 * b + 3) / 100 + 20.5 / 300.015625, (19 * a + 4) / 100 + 20.5 / 259.6015625]
          : [(33.4 * a + 16.7) / 100, (33.4 * b + 16.7) / 100],
        gomoku ? 0.04 : 0.05,
      ),
    ),
    4500,
    9000,
  )
}
export function slideTrack(offset: number) {
  const x = uniform(0.1, 0.15),
    duration = integer(600, 1400),
    builder = new TrackBuilder([uniform(0.3, 0.8), uniform(0.85, 0.99)])
  builder
    .move([x, uniform(0.88, 0.9)], integer(800, 1400))
    .down()
    .move([x + offset / 300.015625, uniform(0.88, 0.9)], duration)
    .end()
  return { track: payload(builder, 261.5234375), passtime: duration }
}
export function svgTrack(cell: Point, columns: number, duration: number) {
  const builder = new TrackBuilder(origin()),
    delay = integer(80, 120)
  builder
    .move(
      jitter([(cell[1]! - 0.5) / columns, (cell[0]! - 0.5) / columns], 0.01),
      Math.max(1, duration - delay),
    )
    .click(delay)
  return payload(builder)
}
export function zipTrack(track: Track, mtime = Date.now()): string {
  return Buffer.from(gzipSync(Buffer.from(JSON.stringify(track)), { mtime })).toString('base64url')
}
