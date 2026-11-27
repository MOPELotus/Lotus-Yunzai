import { createEngine } from '../composition/engine.ts'
import { ModelStore, ModelPool } from '../infrastructure/models.ts'
import { CaptchaError } from '../domain/errors.ts'
import type { Challenge } from '../domain/protocol.ts'

const { modelsDirectory, temporaryDirectory } = JSON.parse(process.env.LOTUS_CAPTCHA_WORKER_DATA!) as { modelsDirectory: string; temporaryDirectory: string }
const store = await ModelStore.create(modelsDirectory, temporaryDirectory)
const models = new ModelPool(store)
const engine = createEngine(models)
let current: { id: string; controller: AbortController; settled: Promise<void> } | undefined
let closed = false
process.on('message', async (message: { type: 'solve' | 'cancel' | 'close'; id: string; challenge: Challenge; timeoutMs: number }) => {
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
    process.send!({ type: 'closed' })
    return
  }
  if (closed || current) {
    process.send!({ id: message.id, error: { code: closed ? 'service_closed' : 'captcha_busy', retryable: !closed } })
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
    process.send!({ id: message.id, proof })
  } catch (error) {
    process.send!({ id: message.id, error: {
      code: error instanceof CaptchaError ? error.code : 'recognition_failed',
      retryable: error instanceof CaptchaError ? error.retryable : true,
    } })
  } finally {
    store.useSignal(undefined)
    current = undefined
    settled.resolve()
  }
})

process.send!({ type: 'ready' })
