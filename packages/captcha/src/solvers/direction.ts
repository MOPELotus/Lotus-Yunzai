import crypto from 'node:crypto'
import type { Puzzle, Solver, Answer, Point } from '../domain/puzzle.ts'
import { ModelPool } from '../infrastructure/models.ts'
import { raster } from '../infrastructure/image.ts'
import { detect, modelMetadata } from '../infrastructure/detector.ts'
const hashes: Record<string, string> = {
  '8da090c135ff029f3b5e19f4c44f73c8': 'u',
  cb0eaa639b2117a69a81af3d8c1496a1: 'd',
  '315ce8665e781dabcd1eb09d3e604803': 'l',
  '38bd9dda695098c7dfad74c921923a7d': 'lu',
  '502e51dbabf411beba2dcd55fd38ebbd': 'ld',
  '2b2387f566f6a03ed594d4d7cfda471f': 'r',
  '78dc29045d587ad054c7353732df53c5': 'ru',
  '23ef93e6b0e0df0e15b66667c99a5fb4': 'rd',
}
export class DirectionSolver implements Solver {
  readonly id = 'click.direction'
  readonly kinds = ['click'] as const
  constructor(private readonly models: ModelPool) {}
  supports(p: Puzzle): boolean {
    return (
      p.kind === 'click' &&
      (p.style === 'direction' || p.style === 'symbols') &&
      p.prompts.length > 0 &&
      p.prompts.every((prompt) => hashes[crypto.createHash('md5').update(prompt).digest('hex')]!)
    )
  }
  async solve(puzzle: Puzzle): Promise<Answer> {
    if (puzzle.kind !== 'click') throw new Error('Expected click puzzle')
    const image = await raster(puzzle.image),
      meta = await modelMetadata('icon-direction'),
      names = [...(meta.custom.names ?? '').matchAll(/(\d+):\s*'([^']+)'/g)]
        .sort((a, b) => Number(a[1]!) - Number(b[1]!))
        .map((m) => m[2]!)
    if (names.length !== 8) throw new Error('Invalid direction model classes')
    const detections = await detect(this.models, 'icon-direction', image, 0.1, 0.45, 4),
      used = new Set<number>(),
      points: Point[] = []
    for (const prompt of puzzle.prompts) {
      const direction = hashes[crypto.createHash('md5').update(prompt).digest('hex')]!
      if (!direction) throw new Error('Unsupported direction question')
      const index = detections.findIndex((d, i) => !used.has(i) && names[d.label]! === direction)
      if (index < 0) throw new Error('Direction not detected')
      used.add(index)
      const box = detections[index]!
      points.push([(box.x + box.width / 2) / image.width, (box.y + box.height / 2) / image.height])
    }
    if (!points.length) throw new Error('Empty directions')
    return { kind: 'points', points }
  }
}
