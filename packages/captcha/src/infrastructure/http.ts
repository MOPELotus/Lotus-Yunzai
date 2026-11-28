import { CaptchaError } from '../domain/errors.ts'
import { retryCaptchaRead } from './retry.ts'
export class HttpClient {
  constructor(readonly fetchImpl: typeof fetch = fetch) {}
  async bytes(url: URL | string, signal: AbortSignal, limit = 8 * 1024 * 1024, retry = true): Promise<Buffer> {
    return retryCaptchaRead(() => this.readBytes(url, signal, limit), signal, { retry })
  }
  private async readBytes(url: URL | string, signal: AbortSignal, limit: number): Promise<Buffer> {
    const response = await this.fetchImpl(url, {
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36',
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new CaptchaError(
        response.status === 429 ? 'rate_limited' : 'upstream_http_error',
        `HTTP ${response.status}`,
        response.status >= 500,
      )
    }
    if (!response.body) throw new CaptchaError('empty_response', undefined, true)
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > limit) throw new CaptchaError('upstream_response_too_large')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    if (!size) throw new CaptchaError('empty_response', undefined, true)
    return Buffer.concat(chunks)
  }
  async jsonp(url: URL, signal: AbortSignal, retry = false): Promise<Record<string, any>> {
    const text = (await this.bytes(url, signal, 1024 * 1024, retry)).toString('utf8').trim()
    const match = text.match(/^(?:[\w$]+)?\(([\s\S]*)\);?$/)
    const parsed = JSON.parse(match ? match[1]! : text) as Record<string, any>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new CaptchaError('invalid_upstream_response')
    if (parsed.status === 'error') {
      const code = Number(parsed.code ?? parsed.data?.code)
      throw Object.assign(new CaptchaError('upstream_api_error'), {
        upstreamCode: Number.isFinite(code) ? code : undefined,
      })
    }
    return parsed
  }
}
