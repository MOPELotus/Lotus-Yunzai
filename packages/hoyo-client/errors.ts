export class HoyoRequestError extends Error {
  constructor(
    readonly code: "invalid-input" | "transport" | "http" | "response" | "api" | "refresh" | "profile-changed",
    message: string,
    readonly status?: number,
    readonly retcode?: number,
  ) {
    super(message);
    this.name = "HoyoRequestError";
  }
}

export class ZzzManualGachaLinkRequired extends HoyoRequestError {
  constructor() {
    super("invalid-input", "当前绝区零国际服档案需要手动录入官方抽卡链接。");
  }
}
