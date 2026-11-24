import type { Puzzle, Solver } from '../domain/puzzle.ts'
import type { ProtocolAdapter } from '../domain/protocol.ts'
import { CaptchaError } from '../domain/errors.ts'

/** The registry knows capabilities, never GeeTest versions or wire fields. */
export class SolverRegistry {
  private readonly solvers = new Map<string, Solver>()
  register(solver: Solver, options: { replace?: boolean } = {}): this {
    if (this.solvers.has(solver.id) && !options.replace)
      throw new Error(`Duplicate solver: ${solver.id}`)
    this.solvers.set(solver.id, solver)
    return this
  }
  candidates(puzzle: Puzzle, preferred: readonly string[] = []): Solver[] {
    const values = [...this.solvers.values()].filter(
      (s) => s.kinds.includes(puzzle.kind) && s.supports(puzzle),
    )
    return values.sort((a, b) => {
      const rank = (id: string) =>
        preferred.includes(id) ? preferred.indexOf(id) : preferred.length
      return rank(a.id) - rank(b.id)
    })
  }
  list(): { id: string; kinds: readonly Puzzle['kind'][] }[] {
    return [...this.solvers.values()].map(({ id, kinds }) => ({ id, kinds }))
  }
}
export class ProtocolRegistry {
  private readonly protocols = new Map<number, ProtocolAdapter>()
  register(protocol: ProtocolAdapter): this {
    if (this.protocols.has(protocol.version))
      throw new Error(`Duplicate protocol: ${protocol.version}`)
    this.protocols.set(protocol.version, protocol)
    return this
  }
  get(version: number): ProtocolAdapter {
    const adapter = this.protocols.get(version)
    if (!adapter) throw new CaptchaError('unsupported_version', undefined, false, 400)
    return adapter
  }
}
