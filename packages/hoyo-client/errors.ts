export class HoyoRequestError extends Error {
  constructor(
    readonly code: "invalid-input" | "transport" | "http" | "response" | "api" | "refresh" | "profile-changed",
    message: string,
    readonly status?: number,
    readonly retcode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HoyoRequestError";
  }
}

/** The last original response explicitly rejected the request; no later dispatch is uncertain. */
export class CaptchaBusinessRejectedError extends HoyoRequestError {
  readonly originalRequestRejected = true;
  constructor(retcode: number, readonly stage: "challenge" | "verification" | "business", cause?: unknown) {
    super("api", "验证码尚未完成，原社区请求未被受理，可重新发起。", 200, retcode,
      cause === undefined ? undefined : { cause });
    this.name = "CaptchaBusinessRejectedError";
  }
}

export function requiresServiceVerification(value: { msg?: unknown; message?: unknown }, header?: string | null) {
  const challenge = header?.trim();
  return (challenge !== undefined && challenge !== "" && challenge !== "{}") ||
    [value.message, value.msg].some(item => typeof item === "string" &&
      /验证码|captcha|geetest|challenge|风控|频繁|rate.?limit|too frequently/iu.test(item));
}

export class ZzzManualGachaLinkRequired extends HoyoRequestError {
  constructor() {
    super("invalid-input", "当前绝区零国际服档案需要手动录入官方抽卡链接。");
  }
}
