import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CaptchaError } from './src/domain/errors.ts'
import type { Challenge, Proof } from './src/domain/protocol.ts'

const defaultModelsDirectory = fileURLToPath(new URL('../../data/captcha/models/', import.meta.url))

export type { Challenge, Proof }
export { CaptchaError }
export interface LocalCaptchaSolver {
  solve(challenge: Challenge, signal: AbortSignal): Promise<Proof>
  close(): Promise<void>
}
interface Options {
  readonly modelsDirectory?: string
  /** Test seam: production always uses the checked-in TypeScript worker. */
  readonly workerUrl?: URL
  readonly timeoutMs?: number
}
interface Reply {
  readonly id?: string
  readonly type?: 'closed'
  readonly proof?: Proof
  readonly error?: { readonly code: string; readonly retryable: boolean }
}
interface OwnedWorker {
  readonly worker: Worker
  readonly temporaryDirectory: string
  dispose?: Promise<void>
}

/** No port, subprocess service, model loading or worker starts during construction. */
export function createLocalCaptchaSolver(options: Options = {}): LocalCaptchaSolver {
  const modelsDirectory = options.modelsDirectory ?? defaultModelsDirectory
  const workerUrl = options.workerUrl ?? new URL('./src/runtime/worker.ts', import.meta.url)
  const timeoutMs = options.timeoutMs ?? 120_000
  let owned: OwnedWorker | undefined
  let active: { cancel(reason: Error): void; settled: Promise<void> } | undefined
  let closed = false
  let closing: Promise<void> | undefined

  async function dispose(target: OwnedWorker) {
    if (target.dispose) return target.dispose
    if (owned === target) owned = undefined
    target.dispose = (async () => {
      await target.worker.terminate().catch(() => undefined)
      // Only this worker writes here; never remove another process's pending download.
      await rm(target.temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    })()
    return target.dispose
  }
  function obtain() {
    if (owned) return owned
    const temporaryDirectory = join(modelsDirectory, '.work', randomUUID())
    const worker = new Worker(workerUrl, { workerData: { modelsDirectory, temporaryDirectory }, execArgv: [] })
    const target: OwnedWorker = { worker, temporaryDirectory }
    owned = target
    worker.on('error', () => { void dispose(target) })
    worker.on('exit', () => { void dispose(target) })
    return target
  }
  async function release(target: OwnedWorker) {
    if (target.dispose) return target.dispose
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); target.worker.off('message', message); resolve() }
      const message = (reply: Reply) => { if (reply.type === 'closed') finish() }
      const timer = setTimeout(finish, 500)
      target.worker.on('message', message)
      try { target.worker.postMessage({ type: 'close' }) } catch { finish() }
    })
    await dispose(target)
  }
  return {
    async solve(challenge, signal) {
      signal.throwIfAborted()
      if (closed) throw new CaptchaError('service_closed', undefined, false, 503)
      if (active) throw new CaptchaError('captcha_busy', undefined, true, 429)
      const target = obtain(), id = randomUUID()
      target.worker.ref()
      const settled = Promise.withResolvers<void>()
      const result = new Promise<Proof>((resolve, reject) => {
        let finished = false, cancelling: Error | undefined
        let cancellationTimer: ReturnType<typeof setTimeout> | undefined
        const finish = async (error?: Error, proof?: Proof, terminate = false, graceful = false) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          if (cancellationTimer) clearTimeout(cancellationTimer)
          signal.removeEventListener('abort', aborted)
          target.worker.off('message', message)
          target.worker.off('error', failed)
          target.worker.off('exit', exited)
          if (terminate) await (graceful ? release(target) : dispose(target))
          else target.worker.unref()
          active = undefined
          settled.resolve()
          if (error) reject(error)
          else resolve(proof!)
        }
        const cancel = (reason: Error) => {
          if (finished || cancelling) return
          cancelling = reason
          try { target.worker.postMessage({ type: 'cancel', id }) } catch { /* Already exited. */ }
          cancellationTimer = setTimeout(() => { void finish(reason, undefined, true) }, 250)
        }
        const aborted = () => cancel(signal.reason instanceof Error ? signal.reason : new CaptchaError('aborted'))
        const message = (reply: Reply) => {
          if (reply.id !== id) return
          if (cancelling) { void finish(cancelling, undefined, true, true); return }
          if (reply.error) void finish(new CaptchaError(reply.error.code, undefined, reply.error.retryable))
          else if (reply.proof) void finish(undefined, reply.proof)
          else void finish(new CaptchaError('invalid_worker_result'), undefined, true)
        }
        const failed = () => { void finish(new CaptchaError('local_worker_failed'), undefined, true) }
        const exited = () => { void finish(new CaptchaError('local_worker_exited'), undefined, true) }
        const timer = setTimeout(() => cancel(new CaptchaError('timeout', undefined, true, 504)), timeoutMs)
        active = { cancel, settled: settled.promise }
        signal.addEventListener('abort', aborted, { once: true })
        target.worker.on('message', message)
        target.worker.once('error', failed)
        target.worker.once('exit', exited)
        try {
          signal.throwIfAborted()
          target.worker.postMessage({ type: 'solve', id, challenge, timeoutMs })
        } catch (error) {
          void finish(error instanceof Error ? error : new CaptchaError('local_worker_failed'), undefined, true)
        }
      })
      return result
    },
    close() {
      if (closing) return closing
      closed = true
      closing = (async () => {
        const running = active
        if (running) {
          running.cancel(new CaptchaError('service_closed', undefined, false, 503))
          await running.settled
        }
        if (owned) await release(owned)
      })()
      return closing
    },
  }
}


export interface CaptchaModelProgress {
  readonly modelId: string
  /** Models fully validated and ready for use. */
  readonly completed: number
  readonly total: number
  readonly stage?: 'checking' | 'downloading' | 'verifying' | 'ready'
  readonly attempt?: number
  readonly maxAttempts?: number
  readonly fileBytes?: number
  readonly fileTotalBytes?: number
  /** Fully validated bytes, excluding a model that is still being prepared. */
  readonly completedBytes?: number
  readonly totalBytes?: number
  readonly cached?: boolean
}

/** Called by the host's overall initialization, never by solve(). */
export async function prepareCaptchaModels(options: {
  readonly signal?: AbortSignal
  readonly modelsDirectory?: string
  readonly onProgress?: (progress: CaptchaModelProgress) => unknown
} = {}): Promise<void> {
  const { ModelStore } = await import('./src/infrastructure/models.ts')
  const directory = options.modelsDirectory ?? defaultModelsDirectory
  const temporaryDirectory = join(directory, '.work', `prepare-${randomUUID()}`)
  const store = await ModelStore.create(directory, temporaryDirectory, true)
  const totalBytes = store.assets.reduce((sum, asset) => sum + asset.size, 0)
  const report = async (event: CaptchaModelProgress) => {
    if (options.signal?.aborted) return
    try { await options.onProgress?.(event) }
    catch { /* Progress observers cannot decide whether a model is usable. */ }
  }
  try {
    let completed = 0, completedBytes = 0
    for (const asset of store.assets) {
      options.signal?.throwIfAborted()
      let downloaded = false
      await store.get(asset.id, options.signal, progress => {
        downloaded ||= progress.stage === 'downloading'
        return report({ modelId: asset.id, stage: progress.stage, completed, total: store.assets.length,
          fileBytes: progress.bytes, fileTotalBytes: progress.totalBytes, attempt: progress.attempt, maxAttempts: progress.maxAttempts, completedBytes, totalBytes })
      })
      options.signal?.throwIfAborted()
      completedBytes += asset.size
      await report({ modelId: asset.id, stage: 'ready', completed: ++completed, total: store.assets.length,
        fileBytes: asset.size, fileTotalBytes: asset.size, completedBytes, totalBytes, cached: !downloaded })
      options.signal?.throwIfAborted()
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}
