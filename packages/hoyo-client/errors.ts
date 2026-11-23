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
