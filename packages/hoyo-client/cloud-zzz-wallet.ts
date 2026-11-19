import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";

export interface CloudZzzWallet {
  readonly freeTimeMinutes: number;
}

interface CloudZzzWalletOptions {
  readonly signal?: AbortSignal;
  readonly verifyProfile?: () => Promise<void>;
}

const walletUrl = "https://cg-nap-api.mihoyo.com/nap_cn/cg/wallet/wallet/get?cost_method=0&get_type=0";
const sessionField = "[A-Za-z0-9._~+/%-]+={0,2}";
const signedSession = new RegExp(`^ai=[1-9]\\d{0,9};ci=\\d{1,10};oi=${sessionField};ct=${sessionField};si=${sessionField};bi=nap_cn$`, "u");
const walletErrors = {
  expired: "云绝区零凭据已失效，请在官方客户端重新登录后绑定。",
  risk: "云绝区零钱包需要额外验证，请在官方客户端处理。",
  "rate-limited": "云绝区零钱包请求过于频繁，请稍后重试。",
  "missing-balance": "云绝区零钱包未返回剩余免费时长。",
  "invalid-balance": "云绝区零钱包返回的剩余免费时长无效。",
} as const;

export class CloudZzzWalletError extends HoyoRequestError {
  constructor(readonly reason: keyof typeof walletErrors, status: number, retcode?: number) {
    const code = status >= 400 ? "http" : reason === "missing-balance" || reason === "invalid-balance" ? "response" : "api";
    super(code, walletErrors[reason], status, retcode);
  }
}

export function normalizeCloudZzzComboToken(input: string): string {
  if (typeof input === "string" && input.length <= 8192 && !/[^\x20-\x7e]/u.test(input)) {
    const token = input.trim();
    // Preserve the Android session header and its existing signature verbatim.
    if (signedSession.test(token)) return token;
  }
  throw new HoyoRequestError("invalid-input", "请输入有效的云绝区零凭据。");
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function readBalance(data: unknown, status: number): number {
  if (data == null) throw new CloudZzzWalletError("missing-balance", status);
  const wallet = object(data);
  const time = wallet?.free_time;
  if (wallet && time == null) throw new CloudZzzWalletError("missing-balance", status);
  const freeTime = object(time);
  const value = freeTime?.free_time;
  if (freeTime && value == null) throw new CloudZzzWalletError("missing-balance", status);
  const count = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new CloudZzzWalletError("invalid-balance", status);
  }
  return count === 0 ? 0 : count;
}

/** Queries the authorized CN cloud session's balance using the Android client's wallet defaults. */
export async function readCloudZzzWallet(comboToken: string, transport: HoyoTransport,
  { signal, verifyProfile }: CloudZzzWalletOptions = {},
): Promise<CloudZzzWallet> {
  const token = normalizeCloudZzzComboToken(comboToken);
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const unavailable = () => new HoyoRequestError("transport", "暂时无法查询云绝区零钱包。");
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
        Accept: "application/json",
        "x-rpc-combo_token": token,
        "x-rpc-client_type": "2",
        "x-rpc-app_version": "3.3.0",
        "x-rpc-cg_game_biz": "nap_cn",
        "x-rpc-op_biz": "clgm_nap-cn",
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
    if (!unexpectedUrl && status === 429) throw new CloudZzzWalletError("rate-limited", status);
    if (!unexpectedUrl && challenge && challenge !== "{}") throw new CloudZzzWalletError("risk", status);
    throw new HoyoRequestError("http", "云绝区零钱包返回异常 HTTP 响应。", status);
  }

  const payload = await readGameRecordPayload(response, 128 * 1024, deadline);
  await guard();
  const retcode = payload?.retcode;
  if (retcode === -100) throw new CloudZzzWalletError("expired", status, retcode);
  if (status !== 200) throw new HoyoRequestError("http", "云绝区零钱包拒绝请求。", status);
  if (typeof retcode !== "number" || !Number.isSafeInteger(retcode)) {
    throw new HoyoRequestError("response", "云绝区零钱包返回了无效响应。");
  }
  if (retcode !== 0) throw new HoyoRequestError("api", "云绝区零钱包拒绝请求。", status, retcode);
  return { freeTimeMinutes: readBalance(payload?.data, status) };
}
