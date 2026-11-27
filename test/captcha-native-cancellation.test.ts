import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLocalCaptchaSolver } from '../packages/captcha/index.ts'

// Minimal synthetic ONNX MatMul, no downloads or official captcha requests.
function uint(value: number): Buffer {
  const bytes: number[] = []
  do { const byte = value & 127; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)) } while (value)
  return Buffer.from(bytes)
}
function field(id: number, value: number | string | Buffer): Buffer {
  if (typeof value === 'number') return Buffer.concat([uint(id * 8), uint(value)])
  const bytes = typeof value === 'string' ? Buffer.from(value) : value
  return Buffer.concat([uint(id * 8 + 2), uint(bytes.length), bytes])
}
function matmul(size: number) {
  const shape = Buffer.concat([field(1, field(1, size)), field(1, field(1, size))])
  const type = field(1, Buffer.concat([field(1, 1), field(2, shape)]))
  const info = (name: string) => Buffer.concat([field(1, name), field(2, type)])
  const node = Buffer.concat([field(1, 'a'), field(1, 'b'), field(2, 'y'), field(4, 'MatMul')])
  const graph = Buffer.concat([field(1, node), field(2, 'synthetic'), field(11, info('a')), field(11, info('b')), field(12, info('y'))])
  return Buffer.concat([field(1, 8), field(7, graph), field(8, field(2, 13))])
}

async function waitFor(file: string) {
  for (let i = 0; i < 1000; i++) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(10)
  }
  throw Error('Native inference did not start')
}

test('cancelling active native ONNX inference and a child crash preserve the host and next task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lotus-captcha-native-cancel-'))
  const workerUrl = pathToFileURL(join(root, 'native.ts'))
  const runtime = import.meta.resolve('../packages/captcha/node_modules/onnxruntime-node/dist/index.js')
  await writeFile(join(root, 'large.onnx'), matmul(6144))
  await writeFile(join(root, 'small.onnx'), matmul(8))
  await writeFile(workerUrl, `
    import * as ort from ${JSON.stringify(runtime)}
    import {writeFileSync} from 'node:fs'
    const root=${JSON.stringify(root)}
    process.on('message',async message=>{
      if(message.type==='close'){process.send({type:'closed'});return}
      if(message.type!=='solve')return
      if(message.challenge.gt==='crash'){process.exit(134)}
      const slow=message.challenge.gt==='native'
      const size=slow?6144:8
      const session=await ort.InferenceSession.create(root+(slow?'/large.onnx':'/small.onnx'),{executionProviders:['cpu'],intraOpNumThreads:1,interOpNumThreads:1})
      const values=new Float32Array(size*size).fill(1)
      const inputs={a:new ort.Tensor('float32',values,[size,size]),b:new ort.Tensor('float32',values,[size,size])}
      const running=session.run(inputs)
      if(slow)writeFileSync(root+'/started',String(process.pid))
      const output=await running
      if(output.y.data[0]!==size)throw Error('Incorrect native result')
      await session.release()
      if(slow)writeFileSync(root+'/finished','yes')
      process.send({id:message.id,proof:{version:3,validate:'native-ok',challenge:message.challenge.challenge,seccode:'native-ok|jordan'}})
    })
    process.send({type:'ready'})
  `)
  const solver = createLocalCaptchaSolver({ workerUrl, modelsDirectory: join(root, 'models'), timeoutMs: 20_000 })
  try {
    const signal = new AbortController()
    const task = solver.solve({ version: 3, gt: 'native', challenge: 'synthetic' }, signal.signal)
    const rejection = task.catch(error => error)
    await waitFor(join(root, 'started'))
    await Bun.sleep(50)
    expect(await Bun.file(join(root, 'finished')).exists()).toBe(false)
    const pid = Number(await readFile(join(root, 'started'), 'utf8'))
    expect(pid).not.toBe(process.pid)
    signal.abort(new Error('cancel native inference'))
    expect((await rejection)?.message).toBe('cancel native inference')
    expect(() => process.kill(pid, 0)).toThrow()
    expect(await Bun.file(join(root, 'finished')).exists()).toBe(false)
    expect(await solver.solve({ version: 3, gt: 'normal', challenge: 'after-cancel' }, new AbortController().signal))
      .toMatchObject({ validate: 'native-ok', challenge: 'after-cancel' })
    await expect(solver.solve({ version: 3, gt: 'crash', challenge: 'synthetic' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'local_worker_exited' })
    expect(await solver.solve({ version: 3, gt: 'normal', challenge: 'after-crash' }, new AbortController().signal))
      .toMatchObject({ validate: 'native-ok', challenge: 'after-crash' })
    const timed = createLocalCaptchaSolver({ workerUrl, modelsDirectory: join(root, 'models'), timeoutMs: 250 })
    try {
      await expect(timed.solve({ version: 3, gt: 'native', challenge: 'timeout' }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'timeout' })
      expect(await timed.solve({ version: 3, gt: 'normal', challenge: 'after-timeout' }, new AbortController().signal))
        .toMatchObject({ validate: 'native-ok', challenge: 'after-timeout' })
    } finally { await timed.close() }

  } finally {
    await solver.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
