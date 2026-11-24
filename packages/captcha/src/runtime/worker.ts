import { parentPort, workerData } from 'node:worker_threads'
import { createEngine } from '../composition/engine.ts'
import { ModelStore, ModelPool } from '../infrastructure/models.ts'
import { CaptchaError } from '../domain/errors.ts'
import type { Challenge } from '../domain/protocol.ts'

const { modelsDirectory, temporaryDirectory } = workerData as { modelsDirectory: string; temporaryDirectory: string }
const store = await ModelStore.create(modelsDirectory, temporaryDirectory)
const models = new ModelPool(store)
const engine = createEngine(models)
let current: { id: string; controller: AbortController; settled: Promise<void> } | undefined
let closed = false
parentPort!.on('message', async (message: { type: 'solve' | 'cancel' | 'close'; id: string; challenge: Challenge; timeoutMs: number }) => {
  if (message.type === 'cancel') {
    if (current?.id === message.id) current.controller.abort(new CaptchaError('aborted'))
    return
  }
  if (message.type === 'close') {
    closed = true
    const running = current
    running?.controller.abort(new CaptchaError('service_closed'))
    await running?.settled
    await models.close()
    parentPort!.postMessage({ type: 'closed' })
    return
  }
  if (closed || current) {
    parentPort!.postMessage({ id: message.id, error: { code: closed ? 'service_closed' : 'captcha_busy', retryable: !closed } })
    return
  }
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(message.timeoutMs)])
  const settled = Promise.withResolvers<void>()
  current = { id: message.id, controller, settled: settled.promise }
  store.useSignal(signal)
  try {
    const proof = await engine.solve(message.challenge, signal)
    signal.throwIfAborted()
    parentPort!.postMessage({ id: message.id, proof })
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: {
      code: error instanceof CaptchaError ? error.code : 'recognition_failed',
      retryable: error instanceof CaptchaError ? error.retryable : true,
    } })
  } finally {
    store.useSignal(undefined)
    current = undefined
    settled.resolve()
  }
})
