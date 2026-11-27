import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createLocalCaptchaSolver } from '../packages/captcha/index.ts'
import { ModelStore } from '../packages/captcha/src/infrastructure/models.ts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lotus-captcha-embedded-'))
  const workerUrl = pathToFileURL(join(directory, 'worker.ts'))
  const engineModule = new URL('../packages/captcha/src/composition/engine.ts', import.meta.url).href
  const modelsModule = new URL('../packages/captcha/src/infrastructure/models.ts', import.meta.url).href
  // This actual Bun TS process loads the migrated native dependencies and real
  // engine, substituting only the upstream network protocol with local inputs.
  await writeFile(workerUrl, `
    const workerData = JSON.parse(process.env.LOTUS_CAPTCHA_WORKER_DATA)
    const parentPort = { on: (...args) => process.on(...args), postMessage: value => process.send(value) }
    import { mkdir, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    import { createEngine } from ${JSON.stringify(engineModule)}
    import { ModelStore, ModelPool } from ${JSON.stringify(modelsModule)}
    const models = new ModelPool(await ModelStore.create(workerData.modelsDirectory))
    const engine = createEngine(models, { protocols: [
      { version: 3, async open(challenge) {
        return { puzzle: { kind: 'silent' }, async submit(answer) {
          if (answer.kind !== 'silent') throw Error('wrong solver')
          return { version: 3, challenge: challenge.challenge + '-sdk', validate: 'fixture-proof', seccode: 'fixture-proof|jordan' }
        } }
      } },
      { version: 4, async open(challenge) {
        return { proof: { version: 4, captcha_id: challenge.captcha_id, lot_number: 'fixture-lot',
          captcha_output: 'fixture-output', pass_token: 'fixture-token', gen_time: '1234' } }
      } },
    ] })
    parentPort.on('message', async message => {
      if (message.type === 'cancel') return
      if (message.type === 'close') {
        await models.close()
        parentPort.postMessage({ type: 'closed' })
        return
      }
      if (message.challenge.gt === 'wait') {
        await mkdir(workerData.temporaryDirectory, { recursive: true })
        await writeFile(join(workerData.temporaryDirectory, 'fixture.part'), 'partial')
        return
      }
      const proof = await engine.solve(message.challenge, AbortSignal.timeout(message.timeoutMs))
      parentPort.postMessage({ id: message.id, proof })
    })
    process.send({ type: 'ready' })
  `)
  return { directory, workerUrl, modelsDirectory: join(directory, 'models') }
}

test('内嵌构造不启动worker，真实Bun TS worker复用本地引擎处理v3/v4且不走HTTP', async () => {
  const setup = await fixture()
  const solver = createLocalCaptchaSolver(setup)
  try {
    expect(await readdir(setup.modelsDirectory).catch(() => [])).toEqual([])
    expect(await solver.solve({ version: 3, gt: 'fixture-gt', challenge: 'initial' }, new AbortController().signal))
      .toEqual({ version: 3, challenge: 'initial-sdk', validate: 'fixture-proof', seccode: 'fixture-proof|jordan' })
    expect(await solver.solve({ version: 4, captcha_id: 'fixture-site', risk_type: 'signed:full:context' }, new AbortController().signal))
      .toEqual({ version: 4, captcha_id: 'fixture-site', lot_number: 'fixture-lot', captcha_output: 'fixture-output', pass_token: 'fixture-token', gen_time: '1234' })
    expect(await readdir(setup.modelsDirectory).catch(() => [])).toEqual([])
  } finally { await solver.close(); await rm(setup.directory, { recursive: true, force: true }) }
  await expect(solver.solve({ version: 3, gt: 'g', challenge: 'c' }, new AbortController().signal)).rejects.toMatchObject({ code: 'service_closed' })
}, 20_000)

test('取消、超时和关闭回收worker独占临时文件，并发占用不创建第二份识别任务', async () => {
  const setup = await fixture()
  const solver = createLocalCaptchaSolver({ ...setup, timeoutMs: 8_000 })
  const controller = new AbortController()
  try {
    // Load native modules before entering the intentionally stalled job.
    await solver.solve({ version: 4, captcha_id: 'fixture-site' }, controller.signal)
    const pending = solver.solve({ version: 3, gt: 'wait', challenge: 'c' }, controller.signal)
    const rejection = pending.then(() => undefined, error => error)
    await expect(solver.solve({ version: 3, gt: 'other', challenge: 'c' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'captcha_busy' })
    const work = join(setup.modelsDirectory, '.work')
    for (let i = 0; i < 100; i++) {
      const entries = await readdir(work).catch(() => [])
      if (entries.length && (await readdir(join(work, entries[0]!))).includes('fixture.part')) break
      await Bun.sleep(10)
    }
    controller.abort(new Error('original operation cancelled'))
    expect((await rejection)?.message).toBe('original operation cancelled')
    expect(await readdir(work)).toEqual([])
    // A cancelled process is replaced, rather than reusing an aborted engine.
    expect((await solver.solve({ version: 4, captcha_id: 'replacement' }, new AbortController().signal)).version).toBe(4)
    const shutdown = solver.solve({ version: 3, gt: 'wait', challenge: 'again' }, new AbortController().signal)
    const rejected = shutdown.then(() => undefined, error => error)
    await solver.close()
    expect((await rejected)?.code).toBe('service_closed')
    expect(await readdir(work)).toEqual([])
  } finally { await solver.close(); await rm(setup.directory, { recursive: true, force: true }) }
}, 20_000)

test('模型只在初始化下载校验，业务缺模型直接失败且取消不留本任务part', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lotus-captcha-models-'))
  const bytes = Buffer.from('fixture-model-data')
  const assets = [{ id: 'fixture', file: 'fixture.onnx', url: 'https://fixture.invalid/model', size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex') }]
  let requests = 0
  const source = (async () => { requests++; return new Response(bytes) }) as unknown as typeof fetch
  try {
    const runtime = new ModelStore(directory, assets, source)
    await expect(runtime.get('fixture')).rejects.toMatchObject({ code: 'model_missing' })
    expect(requests).toBe(0)
    const temporary = join(directory, '.work', 'owned-by-test')
    const initialization = new ModelStore(directory, assets, source, temporary, true)
    expect(await initialization.get('fixture')).toBe(join(directory, 'fixture.onnx'))
    expect(requests).toBe(1)
    expect(await readFile(await runtime.get('fixture'))).toEqual(bytes)
    expect(requests).toBe(1)
    expect(await readdir(temporary)).toEqual([])
    const controller = new AbortController()
    const pending = new ModelStore(directory, [{ ...assets[0]!, file: 'cancel.onnx' }], (async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal!
      return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(bytes.subarray(0, 2))
        signal.addEventListener('abort', () => stream.error(new Error('cancelled download')), { once: true })
      } }))
    }) as unknown as typeof fetch, temporary, true)
    pending.useSignal(controller.signal)
    const download = pending.get('fixture')
    const rejected = download.then(() => undefined, error => error)
    await Bun.sleep(20)
    controller.abort()
    expect(await rejected).toBeInstanceOf(Error)
    expect(await readdir(temporary)).toEqual([])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('生产worker按仓库TypeScript路径启动，无配置文件或dist构建也能安全退出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lotus-captcha-production-worker-'))
  const solver = createLocalCaptchaSolver({ modelsDirectory: directory })
  try {
    // Unsupported versions fail before any official request or model access.
    await expect(solver.solve({ version: 0 } as never, new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported_version' })
    expect(await readdir(directory)).toEqual([])
  } finally { await solver.close(); await rm(directory, { recursive: true, force: true }) }
}, 20_000)

test('识别超时结束本次worker，后续close可重复调用且无后台句柄', async () => {
  const setup = await fixture()
  const solver = createLocalCaptchaSolver({ ...setup, timeoutMs: 20 })
  try {
    await expect(solver.solve({ version: 3, gt: 'wait', challenge: 'timeout' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'timeout' })
    await solver.close()
    await solver.close()
    expect(await readdir(join(setup.modelsDirectory, '.work')).catch(() => [])).toEqual([])
  } finally { await solver.close(); await rm(setup.directory, { recursive: true, force: true }) }
}, 10_000)
