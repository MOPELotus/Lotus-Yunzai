// Port of wulu's bilateral + morphological-gradient template matcher.
import type { Solver, Puzzle, Answer } from '../domain/puzzle.ts'
import { grayImage, vision, extrema } from '../infrastructure/vision.ts'
export class SlideSolver implements Solver {
  readonly id = 'slide.edges'
  readonly kinds = ['slide'] as const
  supports(p: Puzzle): boolean {
    return p.kind === 'slide'
  }
  async solve(puzzle: Puzzle): Promise<Answer> {
    if (puzzle.kind !== 'slide') throw new Error('Expected slide puzzle')
    const cv = await vision(),
      background = await grayImage(puzzle.background, 'zero'),
      piece = await grayImage(puzzle.piece, 'zero')
    const bgSmooth = new cv.Mat(),
      pieceSmooth = new cv.Mat(),
      bgEdge = new cv.Mat(),
      pieceEdge = new cv.Mat(),
      result = new cv.Mat(),
      kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))
    let roi: InstanceType<typeof cv.Mat> | undefined
    try {
      cv.bilateralFilter(background, bgSmooth, 5, 60, 60)
      cv.bilateralFilter(piece, pieceSmooth, 5, 60, 60)
      cv.morphologyEx(bgSmooth, bgEdge, cv.MORPH_GRADIENT, kernel)
      cv.morphologyEx(pieceSmooth, pieceEdge, cv.MORPH_GRADIENT, kernel)
      const search =
        puzzle.y > 0 && puzzle.y + pieceEdge.rows <= bgEdge.rows
          ? (roi = bgEdge.roi(new cv.Rect(0, puzzle.y, bgEdge.cols, pieceEdge.rows)))
          : bgEdge
      cv.matchTemplate(search, pieceEdge, result, cv.TM_CCOEFF_NORMED)
      return { kind: 'slide', offset: extrema(cv, result).maxLoc.x }
    } finally {
      for (const mat of [
        background,
        piece,
        bgSmooth,
        pieceSmooth,
        bgEdge,
        pieceEdge,
        result,
        kernel,
        roi,
      ])
        mat?.delete()
    }
  }
}
