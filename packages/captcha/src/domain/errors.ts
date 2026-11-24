export class CaptchaError extends Error {
  constructor(
    readonly code: string,
    message = code,
    readonly retryable = false,
    readonly status = 502,
    readonly challengeConsumed = true,
  ) {
    super(message)
    this.name = 'CaptchaError'
  }
}
