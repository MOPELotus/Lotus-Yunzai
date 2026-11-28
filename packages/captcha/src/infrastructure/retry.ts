// Adapted from gfriendyelin/captcha-tools-go@b0bcaa5 request retry policy.
// Copyright (c) 2026 gfriendyelin; see ../../third_party/captcha-tools-go/LICENSE.
import { setTimeout as sleep } from 'node:timers/promises'
import { CaptchaError } from '../domain/errors.ts'

/** Reads only: callers must opt out for answer submissions, even HTTP GET ones. */
export async function retryCaptchaRead<T>(read: () => Promise<T>, signal: AbortSignal,
  { retry = true, wait = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }) }:
  { retry?: boolean; wait?: (ms: number, signal: AbortSignal) => Promise<unknown> } = {}): Promise<T> {
  const attempts = retry ? 3 : 1
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try { const value = await read(); signal.throwIfAborted(); return value }
    catch (error) {
      signal.throwIfAborted()
      const temporary = error instanceof CaptchaError ? error.retryable &&
        ['upstream_http_error', 'empty_response'].includes(error.code) :
        error instanceof TypeError || (error instanceof Error &&
          ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']
            .includes(String((error as NodeJS.ErrnoException).code ?? (error.cause as NodeJS.ErrnoException | undefined)?.code)))
      if (!temporary || attempt + 1 >= attempts) throw error
      await wait(150 * (attempt + 1), signal)
    }
  }
}
