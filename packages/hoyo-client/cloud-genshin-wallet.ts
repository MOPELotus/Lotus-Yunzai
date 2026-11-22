import { createHash, randomInt } from "node:crypto";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";

export interface CloudGenshinWallet {
  readonly freeTimeMinutes: number;
  readonly cloudCoins?: number;
  readonly totalTimeMinutes?: number;
}

interface CloudGenshinWalletOptions {
  readonly signal?: AbortSignal;
  readonly browserDeviceId?: string;
  readonly verifyProfile?: () => Promise<void>;
}

interface InternationalCloudGenshinWalletOptions {
  readonly signal?: AbortSignal;
  readonly verifyProfile?: () => Promise<void>;
  readonly language: string;
  readonly deviceId?: string;
  readonly deviceModel?: string;
  readonly androidVersion?: string;
}

export class CloudGenshinWalletError extends HoyoRequestError {
  constructor(readonly reason: "expired" | "risk" | "rate-limited", status: number, retcode?: number, label = "云原神") {
    super(status >= 400 ? "http" : "api", {
      expired: `${label}凭据已失效，请在官方客户端重新登录后绑定。`,
      risk: `${label}钱包需要额外验证，请在官方客户端处理。`,
      "rate-limited": `${label}钱包请求过于频繁，请稍后重试。`,
    }[reason], status, retcode);
  }
}

const walletUrl = "https://api-cloudgame.mihoyo.com/hk4e_cg_cn/wallet/wallet/get";
const internationalWalletUrl = "https://sg-cg-api.hoyoverse.com/hk4e_global/cg/wallet/wallet/get";
const internationalAppVersion = "4.23.0";
const internationalAppSalt = "okr4obncj8bw5a65hbnn5oo6ixjc3l9w";
const browserDeviceIdPattern = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;
const browserComboFields = new Set(["ai", "ci", "oi", "ct", "si", "bi"]);

function invalidComboToken(): never {
  throw new HoyoRequestError("invalid-input", "请输入有效的云原神凭据。");
}

function readComboToken(input: string, gameBiz = "hk4e_cn"): { token: string; appId?: string } {
  if (typeof input !== "string" || input.length > 8192 || /[^\x20-\x7e]/u.test(input)) {
    invalidComboToken();
  }
  const token = input.trim();
  if (!token || / /u.test(token) || /^(?:stoken|ltoken(?:_v2)?|cookie_token(?:_v2)?)=/iu.test(token) ||
      (gameBiz === "hk4e_global" && /^(?:stoken_v2|ltuid(?:_v2)?|account_id(?:_v2)?)=/iu.test(token))) invalidComboToken();
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
  if (fields.size !== browserComboFields.size || fields.get("bi") !== gameBiz ||
      !appId || !/^[1-9]\d{0,9}$/u.test(appId) || !channel || !/^\d{1,10}$/u.test(channel)) invalidComboToken();
  return { token, appId };
}

export function normalizeCloudGenshinComboToken(input: string): string {
  return readComboToken(input).token;
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function readQuantity(value: unknown): number | undefined {
  const count = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) return count === 0 ? 0 : count;
}

function readMinutes(value: unknown, label = "云原神"): number {
  const minutes = readQuantity(value);
  if (minutes === undefined) throw new HoyoRequestError("response", `${label}钱包返回的剩余免费时长无效。`);
  return minutes;
}

/** Reads a cloud session's balance through the public web client's default wallet query. */
export async function readCloudGenshinWallet(comboToken: string, transport: HoyoTransport,
  { signal, browserDeviceId = crypto.randomUUID(), verifyProfile }: CloudGenshinWalletOptions = {},
): Promise<CloudGenshinWallet> {
  const { token, appId } = readComboToken(comboToken);
  if (typeof browserDeviceId !== "string" || !browserDeviceIdPattern.test(browserDeviceId)) {
    throw new HoyoRequestError("invalid-input", "云原神浏览器设备标识无效。");
  }
  const wallet = await readWallet(walletUrl, transport, {
    Accept: "application/json", Origin: "https://ys.mihoyo.com", Referer: "https://ys.mihoyo.com/cloud/",
    "x-rpc-combo_token": token,
    ...(appId && { "x-rpc-app_id": appId }),
    "x-rpc-device_id": browserDeviceId, "x-rpc-client_type": "19", "x-rpc-app_version": "7.2.0",
    "x-rpc-channel": "mihoyo", "x-rpc-vendor_id": "2", "x-rpc-cg_game_biz": "hk4e_cn",
    "x-rpc-op_biz": "clgm_cn", "x-rpc-language": "zh-cn",
  }, { signal, verifyProfile });
  const cloudCoins = readQuantity(object(wallet?.coin)?.coin_num);
  const totalTimeMinutes = readQuantity(wallet?.total_time);
  return {
    freeTimeMinutes: readMinutes(object(wallet?.free_time)?.free_time),
    ...(cloudCoins !== undefined && { cloudCoins }),
    ...(totalTimeMinutes !== undefined && { totalTimeMinutes }),
  };
}

export async function readInternationalCloudGenshinWallet(comboToken: string, transport: HoyoTransport,
  { signal, verifyProfile, language, deviceId, deviceModel, androidVersion }: InternationalCloudGenshinWalletOptions,
) {
  const label = "云原神国际服";
  const { token } = readComboToken(comboToken, "hk4e_global");
  if (typeof language !== "string" || !/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/u.test(language)) {
    throw new HoyoRequestError("invalid-input", "云原神国际服档案的语言设置无效。");
  }
  const now = Math.floor(Date.now() / 1000);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const nonce = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join("");
  const digest = createHash("md5").update(`salt=${internationalAppSalt}&t=${now}&r=${nonce}`).digest("hex");
  const os = androidVersion && /^\d{1,2}(?:\.\d+){0,2}$/u.test(androidVersion) ? androidVersion : "12";
  const model = deviceModel && /^[\x20-\x7e]{1,128}$/u.test(deviceModel) ? deviceModel : "Lotus";
  const wallet = await readWallet(internationalWalletUrl, transport, {
    Accept: "application/json, text/plain, */*", "Content-Type": "application/json; charset=UTF-8",
    Origin: "https://act.hoyolab.com", Referer: "https://app.mihoyo.com",
    "User-Agent": `Mozilla/5.0 (Linux; Android ${os}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 miHoYoBBSOversea/${internationalAppVersion}`,
    "x-rpc-app_version": internationalAppVersion, "x-rpc-combo_token": token,
    ...(deviceId && /^[A-Za-z0-9_-]{1,128}$/u.test(deviceId) && { "x-rpc-device_id": deviceId }),
    "x-rpc-client_type": "3", "x-rpc-cg_game_biz": "hk4e_global", "x-rpc-channel_id": "1", "x-rpc-language": language,
    DS: `${now},${nonce},${digest}`,
  }, { signal, verifyProfile }, label);
  const freeTime = object(wallet?.free_time);
  return {
    ...(freeTime?.free_time != null && { freeTimeMinutes: readMinutes(freeTime.free_time, label) }),
    ...(freeTime?.send_freetime != null && { grantedMinutes: readMinutes(freeTime.send_freetime, label) }),
  };
}

async function readWallet(url: string, transport: HoyoTransport, headers: Record<string, string>,
  { signal, verifyProfile }: Pick<CloudGenshinWalletOptions, "signal" | "verifyProfile">, label = "云原神") {
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const unavailable = () => new HoyoRequestError("transport", `暂时无法查询${label}钱包。`);
  async function guard() {
    signal?.throwIfAborted();
    await verifyProfile?.();
    signal?.throwIfAborted();
    if (timeout.aborted) throw unavailable();
  }

  await guard();
  let response: Response;
  try {
    response = await transport(new URL(url), {
      method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: deadline,
      headers,
    });
  } catch {
    await guard();
    throw unavailable();
  }

  const { status } = response;
  const challenge = response.headers.get("x-rpc-aigis")?.trim();
  const unexpectedUrl = response.redirected || (response.url && response.url !== url);
  if (unexpectedUrl || status === 429 || (challenge && challenge !== "{}") || (status !== 200 && status !== 401)) {
    void response.body?.cancel().catch(() => undefined);
    await guard();
    if (!unexpectedUrl && status === 429) throw new CloudGenshinWalletError("rate-limited", status, undefined, label);
    if (!unexpectedUrl && challenge && challenge !== "{}") throw new CloudGenshinWalletError("risk", status, undefined, label);
    throw new HoyoRequestError("http", `${label}钱包返回异常 HTTP 响应。`, status);
  }

  const payload = await readGameRecordPayload(response, 128 * 1024, deadline);
  await guard();
  const retcode = payload?.retcode;
  if (retcode === -100) throw new CloudGenshinWalletError("expired", status, retcode, label);
  if (status !== 200) throw new HoyoRequestError("http", `${label}钱包拒绝请求。`, status);
  if (typeof retcode !== "number" || !Number.isSafeInteger(retcode)) {
    throw new HoyoRequestError("response", `${label}钱包返回了无效响应。`);
  }
  if (retcode !== 0) throw new HoyoRequestError("api", `${label}钱包拒绝请求。`, status, retcode);
  return object(payload?.data);
}
