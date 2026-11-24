import { SolverRegistry, ProtocolRegistry } from './registries.ts'
import type { Challenge, Proof, ProtocolSession } from '../domain/protocol.ts'
import type { Answer } from '../domain/puzzle.ts'
import { CaptchaError } from '../domain/errors.ts'

/** One session per submission; optional protocol strategies open fresh sessions. */
export class SolveEngine {
  constructor(
    readonly protocols: ProtocolRegistry,
    readonly solvers: SolverRegistry,
    readonly preferences: readonly string[] = [],
  ) {}
  async solve(challenge: Challenge, signal: AbortSignal): Promise<Proof> {
    signal.throwIfAborted()
    return this.session(
      await this.protocols.get(challenge.version).open(challenge, { signal }),
      signal,
    )
  }
  private async session(session: ProtocolSession, signal: AbortSignal, depth = 0): Promise<Proof> {
    if (session.proof) return session.proof
    const fallback = async (error: unknown): Promise<Proof> => {
      signal.throwIfAborted()
      if (!session.fallback || depth >= 1) throw error
      return this.session(await session.fallback(), signal, depth + 1)
    }
    const candidates = this.solvers.candidates(session.puzzle, this.preferences)
    let answer: Answer | undefined,
      last: unknown = new CaptchaError('unsupported_puzzle', `No solver for ${session.puzzle.kind}`)
    for (const solver of candidates) {
      signal.throwIfAborted()
      try {
        answer = await solver.solve(session.puzzle, { signal })
        break
      } catch (error) {
        signal.throwIfAborted()
        last = error
      }
    }
    if (!answer) return fallback(last)
    signal.throwIfAborted()
    try {
      const proof = await session.submit(answer)
      signal.throwIfAborted()
      return proof
    } catch (error) {
      if (error instanceof CaptchaError && error.retryable && error.code !== 'protocol_key_updated')
        return fallback(error)
      throw error
    }
  }
}
