import { createHash, randomInt } from "node:crypto";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";

export class GameRecordRequestError extends HoyoRequestError {
  constructor(subject: string, readonly reason: "expired" | "risk" | "rate-limited",
    code: "api" | "http", status: number, retcode?: number) {
    super(code, {
      expired: `官方${subject}的 Cookie 已失效。`,
      risk: `官方${subject}要求验证，请在官方客户端处理后重试。`,
      "rate-limited": `官方${subject}请求过于频繁，请稍后重试。`,
    }[reason], status, retcode);
  }
}

export function isGameRecordCookieExpired(error: unknown): boolean {
  return error instanceof GameRecordRequestError && error.reason === "expired";
}

const origin = "https://api-takumi-record.mihoyo.com";
const appVersion = "2.40.1";
const signingSalt = "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";
const records = {
  gs: { path: "/game_record/app/genshin/api/dailyNote", gameBiz: "hk4e_cn", regions: ["cn_gf01", "cn_qd01"], uid: /^[1-5]\d{8}$/u },
  sr: { path: "/game_record/app/hkrpg/api/note", gameBiz: "hkrpg_cn", regions: ["prod_gf_cn", "prod_qd_cn"], uid: /^[1-5]\d{8}$/u },
  zzz: { path: "/event/game_record_zzz/api/zzz/note", gameBiz: "nap_cn", regions: ["prod_gf_cn", "prod_qd_cn"], uid: /^[1-9]\d{7,8}$/u },
};
const expiredCodes = new Set([-100, 10001, 10101, 10102, 10103]);
const riskCodes = new Set([1034, 10035, 10041]);
type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function whole(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^-?\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof parsed === "number" && Number.isSafeInteger(parsed)) return parsed;
}

function requestHeaders(source: ProfileRequestContext, query: string): Headers {
  const { account, device } = source;
  const cookie = account.cookie.trim();
  const valid = (value: string) => !/[^\x20-\x7E]/u.test(value);
  if (!cookie.includes("=") || !valid(account.cookie) || !valid(device.id ?? "") || !valid(device.fp ?? "")) {
    throw new HoyoRequestError("invalid-input", "当前档案的 Cookie 或设备字段无效。");
  }
  const time = Math.round(Date.now() / 1000);
  const nonce = randomInt(100000, 1000000);
  const hash = createHash("md5").update(`salt=${signingSalt}&t=${time}&r=${nonce}&b=&q=${query}`).digest("hex");
  const model = device.model && valid(device.model) ? device.model : "Android";
  const android = device.androidVersion && /^\d{1,2}(?:\.\d+){0,2}$/u.test(device.androidVersion) ? device.androidVersion : "12";
  const headers = new Headers({ Accept: "application/json", Cookie: cookie,
    "User-Agent": `Mozilla/5.0 (Linux; Android ${android}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.73 Mobile Safari/537.36 miHoYoBBS/${appVersion}`,
    "x-rpc-app_version": appVersion, "x-rpc-client_type": "5", Referer: "https://webstatic.mihoyo.com/",
    DS: `${time},${nonce},${hash}`,
  });
  if (device.id) headers.set("x-rpc-device_id", device.id);
  if (device.id && device.fp) headers.set("x-rpc-device_fp", device.fp);
  return headers;
}

export async function readGameRecordPayload(response: Response, limit: number, signal: AbortSignal): Promise<Json | undefined> {
  if (!response.body) return;
  if (Number(response.headers.get("Content-Length")) > limit) {
    await response.body.cancel().catch(() => undefined);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) return;
      text += decoder.decode(next.value, { stream: true });
    }
    return object(JSON.parse(text + decoder.decode()));
  } catch {
    return;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function apiError(payload: Json | undefined, status: number, retcode: number | undefined, label: string): HoyoRequestError {
  const message = [payload?.message, payload?.msg, object(payload?.data)?.message].find((item) => typeof item === "string") ?? "";
  const code = status === 401 || status === 429 ? "http" : "api";
  const subject = `${label}查询`;
  if (status === 429) return new GameRecordRequestError(subject, "rate-limited", code, status, retcode);
  if ((retcode !== undefined && riskCodes.has(retcode)) || /验证码|captcha|geetest|challenge|风控/iu.test(String(message))) {
    return new GameRecordRequestError(subject, "risk", code, status, retcode);
  }
  if (/visit too frequently|too frequent|rate limit|频繁/iu.test(String(message))) return new GameRecordRequestError(subject, "rate-limited", code, status, retcode);
  if (status === 401 || (retcode !== undefined && expiredCodes.has(retcode))) return new GameRecordRequestError(subject, "expired", code, status, retcode);
  return new HoyoRequestError("api", `官方${label}接口拒绝请求。`, status, retcode);
}

export function genshinCnRecordRegion({ uid, region, gameBiz }: ProfileRequestContext["role"]) {
  if (!records.gs.uid.test(uid) || (gameBiz && gameBiz !== records.gs.gameBiz)) return;
  const expected = uid.startsWith("5") ? "cn_qd01" : "cn_gf01";
  const savedRegion = region.trim();
  if (savedRegion === expected || (!savedRegion && /^[125]\d{8}$/u.test(uid))) return expected;
}

export async function readCnGameRecord(source: ProfileRequestContext, transport: HoyoTransport,
  { kind, signal }: { readonly kind: "daily-note" | "genshin-index"; readonly signal?: AbortSignal },
  verifyProfile?: () => Promise<void>) {
  const { game, role: { uid, gameBiz } } = source;
  const forNote = kind === "daily-note";
  const label = forNote ? "体力" : "原神战绩";
  const subject = `${label}查询`;
  const route = Object.hasOwn(records, game) ? records[game] : undefined;
  const region = game === "gs" ? genshinCnRecordRegion(source.role) :
    source.role.region.trim() || route?.regions[game !== "zzz" && uid.startsWith("5") ? 1 : 0];
  if ((!forNote && game !== "gs") || !route?.uid.test(uid) || !region || !route.regions.includes(region) || (gameBiz && gameBiz !== route.gameBiz) ||
      (game !== "zzz" && uid.startsWith("5") !== (region === route.regions[1]))) {
    throw new HoyoRequestError("invalid-input", `${subject}仅支持档案中已确认的国服游戏角色和区服。`);
  }
  const endpoint = new URL(forNote ? route.path : "/game_record/app/genshin/api/index", origin);
  endpoint.searchParams.set("role_id", uid);
  endpoint.searchParams.set("server", region);
  const headers = requestHeaders(source, endpoint.search.slice(1));

  async function guard() {
    if (signal?.aborted) throw new HoyoRequestError("transport", `${subject}已取消。`);
    await verifyProfile?.();
    if (signal?.aborted) throw new HoyoRequestError("transport", `${subject}已取消。`);
  }

  await guard();
  const timeout = AbortSignal.timeout(15_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await transport(endpoint, {
      method: "GET", headers, credentials: "omit", redirect: "error",
      signal: deadline,
    });
  } catch {
    throw new HoyoRequestError("transport", `官方${subject}请求未完成。`);
  }
  if (response.redirected || (!response.ok && response.status !== 401 && response.status !== 429)) {
    await response.body?.cancel().catch(() => undefined);
    throw new HoyoRequestError("http", `官方${label}接口返回 HTTP 错误。`, response.status);
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw apiError(undefined, response.status, undefined, label);
  }
  const payload = await readGameRecordPayload(response, forNote ? 64 * 1024 : 2 * 1024 * 1024, deadline);
  await guard();
  if (deadline.aborted) throw new HoyoRequestError("transport", `官方${subject}请求未完成。`);
  const retcode = whole(payload?.retcode);
  if (response.status === 401) throw apiError(payload, response.status, retcode, label);
  if (retcode === undefined) throw new HoyoRequestError("response", `官方${label}响应格式无效。`);
  if (retcode !== 0) throw apiError(payload, response.status, retcode, label);
  const data = object(payload?.data);
  if (!data) throw new HoyoRequestError("response", `官方${label}响应缺少有效数据。`);
  return { data, region };
}
