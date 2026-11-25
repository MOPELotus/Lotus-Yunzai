import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";

export interface LegacyCookieToken {
  readonly accountId: string;
  readonly cookieToken: string;
}

export interface LegacyCookieTokenProof {
  readonly accountId: string;
}

const endpoint = "https://passport-api.mihoyo.com/account/ma-cn-session/web/verifyCookieToken";
const maxResponseBytes = 32 * 1024;

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function accountIdOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d{0,15}$/u.test(value) &&
      Number.isSafeInteger(Number(value)) && String(Number(value)) === value) return value;
}

function invalidResponse(): never {
  throw new HoyoRequestError("response", $t("legacy-cookie-token.text_0cb89bd1c0"));
}

function transportError(): HoyoRequestError {
  return new HoyoRequestError("transport", $t("legacy-cookie-token.text_00ebe861dc"));
}

async function readProof(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body) invalidResponse();
  if (Number(response.headers.get("Content-Length")) > maxResponseBytes) {
    void response.body.cancel().catch(() => undefined);
    invalidResponse();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  let payload = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) invalidResponse();
      payload += decoder.decode(value, { stream: true });
    }
    signal.throwIfAborted();
    return object(JSON.parse(payload + decoder.decode())) ?? invalidResponse();
  } catch {
    if (signal.aborted) throw transportError();
    invalidResponse();
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function verifyLegacyCookieToken({ accountId, cookieToken }: LegacyCookieToken, transport: HoyoTransport,
  { signal }: { readonly signal?: AbortSignal } = {}): Promise<LegacyCookieTokenProof> {
  if (typeof accountId !== "string" || !accountIdOf(accountId) || typeof cookieToken !== "string" ||
      !/^[A-Za-z0-9._~+/%=-]{1,4096}$/u.test(cookieToken) || /^v2_/iu.test(cookieToken)) {
    throw new HoyoRequestError("invalid-input", $t("legacy-cookie-token.text_04aeadbbf8"));
  }
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (deadline.aborted) throw transportError();
  let response: Response;
  try {
    response = await transport(new URL(endpoint), {
      method: "POST", body: "{}", credentials: "omit", redirect: "error", signal: deadline,
      headers: {
        Accept: "application/json", "Content-Type": "application/json",
        Cookie: `account_id=${accountId}; cookie_token=${cookieToken}`,
        Origin: "https://user.mihoyo.com", Referer: "https://user.mihoyo.com/passport/index.html",
        "x-rpc-app_id": "dw9y09jqjpxc",
      },
    });
  } catch {
    throw transportError();
  }
  if (deadline.aborted || !response.ok || response.redirected) {
    void response.body?.cancel().catch(() => undefined);
    if (deadline.aborted) throw transportError();
    throw new HoyoRequestError("http", $t("legacy-cookie-token.text_2390c466ba"), response.status);
  }
  const challenge = response.headers.get("x-rpc-aigis")?.trim();
  if (challenge && challenge !== "{}") {
    void response.body?.cancel().catch(() => undefined);
    throw new HoyoRequestError("api", $t("legacy-cookie-token.text_15849001cc"));
  }
  const payload = await readProof(response, deadline);
  if (deadline.aborted) throw transportError();
  if (typeof payload.retcode !== "number" || !Number.isSafeInteger(payload.retcode)) invalidResponse();
  if (payload.retcode !== 0) {
    throw new HoyoRequestError("api", $t("legacy-cookie-token.text_b3fde6aa06"), response.status, payload.retcode);
  }
  const user = object(object(payload.data)?.user_info);
  if (accountIdOf(user?.aid) !== accountId) invalidResponse();
  return { accountId };
}
