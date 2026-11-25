import { createTranslator as createTextTranslator } from "../../../i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("captcha", messageCatalog.messages);
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type * as ort from 'onnxruntime-node'
import { CaptchaError } from '../domain/errors.ts'
import { rootPath } from './paths.ts'

export interface ModelAsset {
  id: string
  file: string
  url: string
  sha256: string
  size: number
}
export interface ModelAssetProgress {
  readonly modelId: string
  readonly stage: 'checking' | 'downloading' | 'verifying'
  readonly bytes: number
  readonly totalBytes: number
  readonly attempt?: number
  readonly maxAttempts?: number
}
export type ModelAssetProgressListener = (progress: ModelAssetProgress) => unknown

function modelProgress(asset: ModelAsset, signal?: AbortSignal, onProgress?: ModelAssetProgressListener, attempt?: number) {
  let lastStage: ModelAssetProgress['stage'] | undefined
  let lastTime = -Infinity
  return (stage: ModelAssetProgress['stage'], bytes: number, force = false) => {
    if (!onProgress || signal?.aborted) return
    const time = Date.now()
    if (!force && stage === lastStage && bytes !== asset.size && time - lastTime < 250) return
    lastStage = stage
    lastTime = time
    try {
      void Promise.resolve(onProgress({ modelId: asset.id, stage, bytes, totalBytes: asset.size, ...(attempt && { attempt, maxAttempts: 3 }) })).catch(() => {})
    } catch { /* A progress display must not interrupt model preparation. */ }
  }
}

export class ModelStore {
  private readonly verified = new Map<string, { size: number; mtime: number }>()
  private readonly pending = new Map<string, Promise<string>>()
  private activeSignal?: AbortSignal
  useSignal(signal: AbortSignal | undefined) { this.activeSignal = signal }
  constructor(
    readonly directory: string,
    readonly assets: readonly ModelAsset[],
    readonly fetchImpl: typeof fetch = fetch,
    readonly temporaryDirectory?: string,
    readonly allowDownload = false,
  ) {}
  static async create(directory = 'data/models', temporaryDirectory?: string, allowDownload = false): Promise<ModelStore> {
    const assets = JSON.parse(
      await fs.readFile(path.join(rootPath, 'resources/models.json'), 'utf8'),
    ) as ModelAsset[]
    return new ModelStore(path.resolve(rootPath, directory), assets, fetch, temporaryDirectory, allowDownload)
  }
  asset(id: string): ModelAsset {
    const asset = this.assets.find((a) => a.id === id)
    if (!asset || path.basename(asset.file) !== asset.file || !/^[a-f\d]{64}$/.test(asset.sha256))
      throw new Error(`Invalid model asset: ${id}`)
    return asset
  }
  async valid(id: string, signal?: AbortSignal, onProgress?: ModelAssetProgressListener): Promise<boolean> {
    signal ??= this.activeSignal
    signal?.throwIfAborted()
    const asset = this.asset(id),
      target = path.join(this.directory, asset.file)
    const progress = modelProgress(asset, signal, onProgress)
    progress('checking', 0, true)
    const stat = await fs.stat(target).catch((e) => {
      if (e.code !== 'ENOENT') throw e
      return null
    })
    signal?.throwIfAborted()
    if (!stat?.isFile() || stat.size !== asset.size) return false
    const cached = this.verified.get(id)
    if (cached?.size === stat.size && cached.mtime === stat.mtimeMs) {
      progress('verifying', stat.size, true)
      return true
    }
    const hash = createHash('sha256')
    let checked = 0
    progress('verifying', 0, true)
    for await (const chunk of createReadStream(target, { signal })) {
      signal?.throwIfAborted()
      hash.update(chunk)
      checked += chunk.length
      progress('verifying', checked)
    }
    signal?.throwIfAborted()
    if (hash.digest('hex') !== asset.sha256) return false
    this.verified.set(id, { size: stat.size, mtime: stat.mtimeMs })
    return true
  }
  async get(id: string, signal?: AbortSignal, onProgress?: ModelAssetProgressListener): Promise<string> {
    signal ??= this.activeSignal
    signal?.throwIfAborted()
    if (await this.valid(id, signal, onProgress)) return path.join(this.directory, this.asset(id).file)
    if (!this.allowDownload) throw new CaptchaError('model_missing', $t("src.infrastructure.models.text_d8a98724fd"), true)
    let promise = this.pending.get(id)
    if (!promise) {
      promise = this.download(id, signal, onProgress)
      this.pending.set(id, promise)
    }
    try {
      return await promise
    } finally {
      if (this.pending.get(id) === promise) this.pending.delete(id)
    }
  }
  private async download(id: string, signal?: AbortSignal, onProgress?: ModelAssetProgressListener): Promise<string> {
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000)
    const asset = this.asset(id), url = new URL(asset.url), fromHuggingFace = url.hostname === 'huggingface.co'
    signal.throwIfAborted()
    if (process.env.HF_ENDPOINT && fromHuggingFace) {
      const endpoint = new URL(process.env.HF_ENDPOINT)
      url.host = endpoint.host
      url.protocol = endpoint.protocol
    }
    const headers: Record<string, string> = {}
    if (process.env.HF_TOKEN && fromHuggingFace)
      headers.Authorization = `Bearer ${process.env.HF_TOKEN}`
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted()
      try { return await this.downloadAttempt(asset, url, headers, signal, onProgress, attempt) }
      catch (error) {
        signal.throwIfAborted()
        const details = error as { code?: string; status?: number; message?: string }
        const retryable = details.status === 408 || details.status === 429 || (details.status !== undefined && details.status >= 500) ||
          /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/.test(details.code ?? '') ||
          /fetch failed|network|socket|connection|TLS|certificate/i.test(details.message ?? '')
        if (!retryable) throw error
        if (attempt === 3) throw new Error($t("src.infrastructure.models.text_9e4cc7b109", { "id": id, "hostname": url.hostname, "value3": details.code ?? $t("src.infrastructure.models.text_88c035ff99") }), { cause: error })
        await sleep(500 * attempt, undefined, { signal })
      }
    }
  }
  private async downloadAttempt(asset: ModelAsset, url: URL, headers: Record<string, string>, signal: AbortSignal,
    onProgress: ModelAssetProgressListener | undefined, attempt: number): Promise<string> {
    const id = asset.id, progress = modelProgress(asset, signal, onProgress, attempt)
    progress('downloading', 0, true)
    const response = await this.fetchImpl(url, { headers, signal })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw Object.assign(new Error(`Model ${id}: HTTP ${response.status}`), { status: response.status })
    }
    await fs.mkdir(this.directory, { recursive: true })
    if (this.temporaryDirectory) await fs.mkdir(this.temporaryDirectory, { recursive: true })
    const target = path.join(this.directory, asset.file),
      temp = path.join(this.temporaryDirectory ?? this.directory, `${asset.file}.${randomUUID()}.part`),
      hash = createHash('sha256')
    let size = 0
    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length
            if (size > asset.size) { callback(new Error('Model exceeds expected size')); return }
            hash.update(chunk)
            progress('downloading', size)
            callback(null, chunk)
          },
        }),
        createWriteStream(temp, { flags: 'wx' }),
        { signal },
      )
      signal.throwIfAborted()
      progress('verifying', 0, true)
      if (size !== asset.size || hash.digest('hex') !== asset.sha256)
        throw new Error(`Model ${id}: checksum mismatch`)
      signal.throwIfAborted()
      await fs.rename(temp, target)
      return target
    } finally {
      await fs.rm(temp, { force: true })
    }
  }
  async status() {
    return Promise.all(this.assets.map(async (a) => ({ id: a.id, ok: await this.valid(a.id) })))
  }
  async json<T>(id: string): Promise<T> {
    return JSON.parse(await fs.readFile(await this.get(id), 'utf8')) as T
  }
}
export class ModelPool {
  private readonly sessions = new Map<string, Promise<ort.InferenceSession>>()
  constructor(readonly store: ModelStore) {}
  async session(id: string): Promise<ort.InferenceSession> {
    if (!this.sessions.has(id))
      this.sessions.set(
        id,
        this.store
          .get(id)
          .then(async (file) => {
            const runtime = await import('onnxruntime-node')
            return runtime.InferenceSession.create(file, {
              executionProviders: ['cpu'],
              intraOpNumThreads: 2,
              interOpNumThreads: 1,
            })
          })
          .catch((error) => {
            this.sessions.delete(id)
            throw error
          }),
      )
    return this.sessions.get(id)!
  }
  async close(): Promise<void> {
    const sessions = await Promise.allSettled(this.sessions.values())
    this.sessions.clear()
    for (const session of sessions)
      if (session.status === 'fulfilled') await session.value.release()
  }
}
