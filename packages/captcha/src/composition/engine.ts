/** Composition root: all cross-layer wiring is explicit and lives here. */
import { SolveEngine } from '../application/engine.ts'
import { ProtocolRegistry, SolverRegistry } from '../application/registries.ts'
import { V3Adapter } from '../protocols/v3/adapter.ts'
import { V4Adapter } from '../protocols/v4/adapter.ts'
import { HttpClient } from '../infrastructure/http.ts'
import { ModelPool } from '../infrastructure/models.ts'
import { GridClassifier, GridMatcher } from '../solvers/grid.ts'
import { GridSemanticRecovery } from '../solvers/grid-recovery.ts'
import { EmbeddedClickSolver } from '../solvers/embedded-adapter.ts'
import { BoardSolver, SilentSolver } from '../solvers/board.ts'
import { SlideSolver } from '../solvers/slide.ts'
import { SvgSolver } from '../solvers/svg.ts'
import { DirectionSolver } from '../solvers/direction.ts'
import { SymbolEmbeddingSolver } from '../solvers/symbol-embedding.ts'
import { WordSolver, PhraseSolver } from '../solvers/text.ts'
import { VoiceSolver } from '../solvers/voice.ts'
import type { Solver } from '../domain/puzzle.ts'
import type { ProtocolAdapter } from '../domain/protocol.ts'
export function createEngine(
  models: ModelPool,
  options: {
    fetch?: typeof fetch
    solvers?: readonly Solver[]
    protocols?: readonly ProtocolAdapter[]
    preferences?: readonly string[]
    voiceFallback?: boolean
  } = {},
): SolveEngine {
  const protocols = new ProtocolRegistry()
  for (const protocol of options.protocols || [
    new V3Adapter(options.fetch),
    new V4Adapter(new HttpClient(options.fetch), { voiceFallback: options.voiceFallback }),
  ])
    protocols.register(protocol)
  const solvers = new SolverRegistry()
  const builtins: Solver[] = [
    new SilentSolver(),
    new BoardSolver(),
    new SlideSolver(),
    new SvgSolver(),
    new GridMatcher(models),
    new GridSemanticRecovery(models),
    new GridClassifier(models, { emptyFallback: true }),
    new GridClassifier(models),
    new EmbeddedClickSolver(models, 'embedded-pairs'),
    new EmbeddedClickSolver(models, 'embedded-similarity'),
    new DirectionSolver(models),
    new SymbolEmbeddingSolver(models),
    new WordSolver(models),
    new PhraseSolver(models, 'word-detect', { lexicon: true }),
    new PhraseSolver(models, 'word-detect'),
    new PhraseSolver(models),
    new VoiceSolver(),
  ]
  for (const solver of builtins) solvers.register(solver)
  for (const solver of options.solvers || []) solvers.register(solver, { replace: true })
  return new SolveEngine(protocols, solvers, options.preferences)
}
