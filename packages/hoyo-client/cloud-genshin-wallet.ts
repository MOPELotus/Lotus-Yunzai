import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";

export interface CloudGenshinWallet {
  readonly freeTimeMinutes: number;
}

interface CloudGenshinWalletOptions {
  readonly signal?: AbortSignal;
  readonly browserDeviceId?: string;
  readonly verifyProfile?: () => Promise<void>;
}

export class CloudGenshinWalletError extends HoyoRequestError {
  constructor(readonly reason: "expired" | "risk" | "rate-limited", status: number, retcode?: number) {
    super(status >= 400 ? "http" : "api", {
      expired: "云原神凭据已失效，请在官方客户端重新登录后绑定。",
      risk: "云原神钱包需要额外验证，请在官方客户端处理。",
      "rate-limited": "云原神钱包请求过于频繁，请稍后重试。",
    }[reason], status, retcode);
  }
}

const walletUrl = "https://api-cloudgame.mihoyo.com/hk4e_cg_cn/wallet/wallet/get";
const browserDeviceIdPattern = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;
const browserComboFields = new Set(["ai", "ci", "oi", "ct", "si", "bi"]);

function invalidComboToken(): never {
  throw new HoyoRequestError("invalid-input", "请输入有效的云原神凭据。");
}

function readComboToken(input: string): { token: string; appId?: string } {
  if (typeof input !== "string" || input.length > 8192 || /[^\x20-\x7e]/u.test(input)) {
    invalidComboToken();
  }
  const token = input.trim();
  if (!token || / /u.test(token) || /^(?:stoken|ltoken(?:_v2)?|cookie_token(?:_v2)?)=/iu.test(token)) invalidComboToken();
  if (!token.includes(";")) return { token };

  // The browser builds this envelope and its app-id header from the same login session.
  const fields = new Map<string, string>();
  for (const element of token.split(";")) {
    const separator = element.indexOf("=");
    const key = element.slice(0, separator);
    const value = element.slice(separator + 1);
    if (separator < 1 || !browserComboFields.has(key) || fields.has(key) || !value) invalidComboToken();
    fields.set(key, value);
  }
  const appId = fields.get("ai");
  const channel = fields.get("ci");
  if (fields.size !== browserComboFields.size || fields.get("bi") !== "hk4e_cn" ||
      !appId || !/^[1-9]\d{0,9}$/u.test(appId) || !channel || !/^\d{1,10}$/u.test(channel)) invalidComboToken();
  return { token, appId };
}

export function normalizeCloudGenshinComboToken(input: string): string {
  return readComboToken(input).token;
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function readMinutes(value: unknown): number {
  const count = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new HoyoRequestError("response", "云原神钱包返回的剩余免费时长无效。");
  }
  return count === 0 ? 0 : count;
}

/** Reads a cloud session's balance through the public web client's default wallet query. */
export async function readCloudGenshinWallet(comboToken: string, transport: HoyoTransport,
  { signal, browserDeviceId = crypto.randomUUID(), verifyProfile }: CloudGenshinWalletOptions = {},
): Promise<CloudGenshinWallet> {
  const { token, appId } = readComboToken(comboToken);
  if (typeof browserDeviceId !== "string" || !browserDeviceIdPattern.test(browserDeviceId)) {
    throw new HoyoRequestError("invalid-input", "云原神浏览器设备标识无效。");
  }
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const unavailable = () => new HoyoRequestError("transport", "暂时无法查询云原神钱包。");
  async function guard() {
    signal?.throwIfAborted();
    await verifyProfile?.();
    signal?.throwIfAborted();
    if (timeout.aborted) throw unavailable();
  }

  await guard();
  let response: Response;
  try {
    response = await transport(new URL(walletUrl), {
      method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: deadline,
      headers: {
        Accept: "application/json", Origin: "https://ys.mihoyo.com", Referer: "https://ys.mihoyo.com/cloud/",
        "x-rpc-combo_token": token,
        ...(appId && { "x-rpc-app_id": appId }),
        "x-rpc-device_id": browserDeviceId, "x-rpc-client_type": "19", "x-rpc-app_version": "7.2.0",
        "x-rpc-channel": "mihoyo", "x-rpc-vendor_id": "2", "x-rpc-cg_game_biz": "hk4e_cn",
        "x-rpc-op_biz": "clgm_cn", "x-rpc-language": "zh-cn",
      },
    });
  } catch {
    await guard();
    throw unavailable();
  }

  const { status } = response;
  const challenge = response.headers.get("x-rpc-aigis")?.trim();
  const unexpectedUrl = response.redirected || (response.url && response.url !== walletUrl);
  if (unexpectedUrl || status === 429 || (challenge && challenge !== "{}") || (status !== 200 && status !== 401)) {
    void response.body?.cancel().catch(() => undefined);
    await guard();
    if (!unexpectedUrl && status === 429) throw new CloudGenshinWalletError("rate-limited", status);
    if (!unexpectedUrl && challenge && challenge !== "{}") throw new CloudGenshinWalletError("risk", status);
    throw new HoyoRequestError("http", "云原神钱包返回异常 HTTP 响应。", status);
  }

  const payload = await readGameRecordPayload(response, 128 * 1024, deadline);
  await guard();
  const retcode = payload?.retcode;
  if (retcode === -100) throw new CloudGenshinWalletError("expired", status, retcode);
  if (status !== 200) throw new HoyoRequestError("http", "云原神钱包拒绝请求。", status);
  if (typeof retcode !== "number" || !Number.isSafeInteger(retcode)) {
    throw new HoyoRequestError("response", "云原神钱包返回了无效响应。");
  }
  if (retcode !== 0) throw new HoyoRequestError("api", "云原神钱包拒绝请求。", status, retcode);
  const freeTime = object(object(payload?.data)?.free_time);
  return { freeTimeMinutes: readMinutes(freeTime?.free_time) };
}
