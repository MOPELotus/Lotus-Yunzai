// Port of wulu's SVG frame extraction and OpenCV edge matching; MIT licensed.
import { XMLParser, XMLBuilder } from 'fast-xml-parser'
import { Resvg } from '@resvg/resvg-js'
import type { Puzzle, Solver, Answer } from '../domain/puzzle.ts'
import { grayImage, vision, extrema } from '../infrastructure/vision.ts'
type XmlNode = Record<string, any>
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false }),
  builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false })
function frames(nodes: XmlNode[]): XmlNode[] {
  return nodes.flatMap((node) =>
    Object.entries(node)
      .filter(([key]) => key !== ':@')
      .flatMap(([key, value]) => {
        if (key === 'g' && String(node[':@']!?.['@_class'] || '').includes('geetest_frame_hash'))
          return [node]
        return Array.isArray(value) ? frames(value) : []
      }),
  )
}
export function frameTimes(svg: string): [number, number][] {
  const seconds = svg.match(/geetest_frame\d_animation_hash\s+([\d.]+)s/)?.[1]
  if (!seconds) throw new Error('Missing frame duration')
  const total = Math.round(Number(seconds) * 1000),
    result: [number, number][] = []
  for (let n = 1; n <= 3; n++) {
    const start = svg.search(new RegExp(`@keyframes geetest_frame${n}_animation_hash\\s*\\{`))
    if (start < 0) throw new Error('Missing keyframe')
    let depth = 0,
      end = svg.indexOf('{', start)
    for (; end < svg.length; end++) {
      if (svg[end]! === '{') depth++
      if (svg[end]! === '}' && --depth === 0) break
    }
    const visible = [...svg.slice(start, end + 1).matchAll(/([\d.]+)%\s*\{\s*opacity:\s*([\d.]+)/g)]
      .filter((m) => Number(m[2]!) > 0)
      .map((m) => Number(m[1]!))
    if (!visible.length) throw new Error('No visible keyframe')
    result.push([
      Math.round((Math.min(...visible) / 100) * total),
      Math.round((Math.max(...visible) / 100) * total),
    ])
  }
  return result
}
function hasStyle(nodes: XmlNode[]): boolean {
  return nodes.some(
    (node) =>
      ['@_style', '@_fill', '@_stroke'].some((key) => node[':@']!?.[key]) ||
      Object.values(node).some((value) => Array.isArray(value) && hasStyle(value)),
  )
}
function outline(nodes: XmlNode[]): void {
  for (const node of nodes)
    for (const [key, value] of Object.entries(node)) {
      if (['path', 'circle', 'ellipse', 'rect', 'polygon', 'polyline', 'line'].includes(key)) {
        const attrs = (node[':@'] ||= {})
        if (!attrs['@_fill']! && !String(attrs['@_style']! || '').includes('fill'))
          attrs['@_fill'] = 'none'
      }
      if (Array.isArray(value)) outline(value)
    }
}
export function extractGrids(svg: string): { grids: string[]; columns: number } {
  const all = frames(parser.parse(svg) as XmlNode[]),
    grids: string[] = []
  const firstRects = (all[0]!?.g || []).filter(
    (n: XmlNode) => n.rect && String(n[':@']!?.['@_class'] || '').includes('geetest_grid_hash'),
  )
  const columns = new Set(
    firstRects.map((n: XmlNode) => Math.round(Number(n[':@']!?.['@_x'] || 0) * 10)),
  ).size
  for (const frame of all) {
    const children = frame.g as XmlNode[]
    for (let i = 0; i < children.length; i++) {
      const rect = children[i]!,
        next = children[i + 1]!
      if (
        !rect.rect ||
        !String(rect[':@']!?.['@_class'] || '').includes('geetest_grid_hash') ||
        !next?.g
      )
        continue
      const width = Number(rect[':@']!['@_width']!),
        height = Number(rect[':@']!['@_height']!)
      if (!width || !height) continue
      const clone = structuredClone(next),
        attrs = (clone[':@'] ||= {}),
        transform = String(attrs['@_transform']! || '')
      const translated = transform.indexOf('translate(')
      if (translated >= 0) {
        const end = transform.indexOf(')', translated)
        attrs['@_transform'] =
          transform.slice(0, translated) +
          `translate(${width / 2},${height / 2}` +
          transform
            .slice(end)
            .replace(/scale\(-?[\d.]+\)/g, 'scale(1)')
            .replace(/rotate\(-?[\d.]+\)/g, 'rotate(0)')
      }
      if (!hasStyle([next]))
        Object.assign(attrs, {
          '@_fill': 'none',
          '@_stroke': '#000',
          '@_stroke-width': '2',
          '@_stroke-linecap': 'round',
          '@_stroke-linejoin': 'round',
        })
      outline(clone.g)
      grids.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${builder.build([clone])}</svg>`,
      )
    }
  }
  if (!grids.length || !columns) throw new Error('No valid SVG grid')
  return { grids, columns }
}
export class SvgSolver implements Solver {
  readonly id = 'svg.edges'
  readonly kinds = ['svg'] as const
  supports(p: Puzzle): boolean {
    return p.kind === 'svg'
  }
  async solve(puzzle: Puzzle): Promise<Answer> {
    if (puzzle.kind !== 'svg') throw new Error('Expected SVG puzzle')
    const cv = await vision(),
      { grids, columns } = extractGrids(puzzle.question),
      times = frameTimes(puzzle.question)
    const edges: InstanceType<typeof cv.Mat>[] = [],
      hint = await grayImage(puzzle.answers),
      median = new cv.Mat(),
      smooth = new cv.Mat(),
      base = new cv.Mat()
    try {
      cv.medianBlur(hint, median, 3)
      cv.bilateralFilter(median, smooth, 5, 50, 50)
      cv.Canny(smooth, base, 50, 150)
      for (const svg of grids) {
        const gray = await grayImage(new Resvg(svg).render().asPng()),
          edge = new cv.Mat()
        try {
          cv.Canny(gray, edge, 50, 150)
          edges.push(edge)
        } finally {
          gray.delete()
        }
      }
      const seed = /data-captcha-type\s*=\s*["']geetest-svg["']/.test(puzzle.question),
        cells = grids.length / 3
      const angles = seed ? [12, 14, 16] : [0],
        scales = seed ? [1.3, 1.4, 1.5] : [cells === 4 ? 0.5 : 1]
      const scores = edges.map(() => -1)
      for (const [combo, [angle, scale]] of angles
        .flatMap((a) => scales.map((s) => [a, s] as const))
        .entries()) {
        let rotated = base.clone(),
          template = new cv.Mat()
        try {
          if (angle) {
            const matrix = cv.getRotationMatrix2D(
              new cv.Point(base.cols / 2, base.rows / 2),
              angle,
              1,
            )
            try {
              cv.warpAffine(
                base,
                rotated,
                matrix,
                new cv.Size(base.cols, base.rows),
                cv.INTER_LINEAR,
                cv.BORDER_CONSTANT,
                new cv.Scalar(0),
              )
            } finally {
              matrix.delete()
            }
          }
          cv.resize(rotated, template, new cv.Size(0, 0), scale, scale, cv.INTER_AREA)
          for (let i = 0; i < edges.length; i++) {
            if (template.rows > edges[i]!.rows || template.cols > edges[i]!.cols) continue
            const result = new cv.Mat()
            try {
              cv.matchTemplate(edges[i]!, template, result, cv.TM_CCOEFF_NORMED)
              scores[i] = Math.max(scores[i]!, extrema(cv, result).maxVal)
            } finally {
              result.delete()
            }
          }
        } finally {
          rotated.delete()
          template.delete()
        }
        const sorted = [...scores].sort((a, b) => b - a)
        if (combo === 0 && sorted[0]! >= 0.35 && sorted[0]! - sorted[1]! >= 0.06) break
      }
      const best = scores.indexOf(Math.max(...scores))
      if (scores[best]! < 0) throw new Error('Hint larger than all grids')
      const frame = Math.floor(best / cells),
        inner = best % cells
      return {
        kind: 'svg',
        cell: [Math.floor(inner / columns) + 1, (inner % columns) + 1],
        frame,
        columns,
        start: times[frame]![0]!,
        end: times[frame]![1]!,
      }
    } finally {
      for (const mat of [hint, median, smooth, base, ...edges]) mat.delete()
    }
  }
}
