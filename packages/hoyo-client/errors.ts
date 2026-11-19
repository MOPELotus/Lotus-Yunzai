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
