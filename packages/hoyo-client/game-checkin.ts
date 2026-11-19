import { createHash, randomInt } from "node:crypto";
import type { Game, ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { GameRecordRequestError, genshinCnRecordRegion, readGameRecordPayload } from "./game-record.ts";

interface GameCheckinOptions {
  readonly signal?: AbortSignal;
}

export interface GameCheckinProof {
  readonly challenge: string;
  readonly validate: string;
  readonly seccode: string;
}

interface GameCheckinSubmitOptions extends GameCheckinOptions {
  readonly proof?: GameCheckinProof;
}

export interface GameCheckinChallenge {
  readonly captchaVersion: 3;
  readonly gt: string;
  readonly challenge: string;
  readonly success?: boolean | 0 | 1;
  readonly new_captcha?: boolean | 0 | 1;
}

export class GameCheckinChallengeError extends GameRecordRequestError {
  constructor(subject: string, status: number, readonly challenge: GameCheckinChallenge) {
    super(subject, "risk", "api", status, 0);
  }
}

export interface CnGameCheckinInfo {
  readonly signed: boolean;
  readonly firstBind: boolean;
  readonly totalSignDays?: number;
}

export type CnGameCheckinSource = Omit<ProfileRequestContext, "game"> & { readonly game: Game | "nxx" | "bh3" };

export function isBh3CnCheckinRegion(region: string) {
  return region === "ios01" || region === "android01" || region === "pc01";
}

const webVersion = "2.118.1";
const webSalt = "4751cb5557bfad5e249e58462c39fb0a";
const randomAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
const origin = "https://webstatic.mihoyo.com";
const routes = {
  gs: { endpoint: "https://api-takumi.mihoyo.com/event/luna", activity: "e202311201442471",
    signgame: "hk4e", biz: "hk4e_cn", name: "原神" },
  sr: { endpoint: "https://api-takumi.mihoyo.com/event/luna/hkrpg", activity: "e202304121516551",
    signgame: "hkrpg", biz: "hkrpg_cn", name: "星铁" },
  zzz: { endpoint: "https://act-nap-api.mihoyo.com/event/luna/zzz", activity: "e202406242138391",
    signgame: "zzz", biz: "nap_cn", name: "绝区零" },
  // The previous Lotus client used the shared Luna route without a signgame header for both games.
  nxx: { endpoint: "https://api-takumi.mihoyo.com/event/luna", activity: "e202202251749321",
    signgame: "", biz: "nxx_cn", name: "未定事件簿" },
  bh3: { endpoint: "https://api-takumi.mihoyo.com/event/luna", activity: "e202306201626331",
    signgame: "", biz: "bh3_cn", name: "崩坏3" },
} as const satisfies Record<CnGameCheckinSource["game"], { endpoint: string; activity: string; signgame: string; biz: string; name: string }>;

type Json = Record<string, unknown>;
type SignRoute = typeof routes[CnGameCheckinSource["game"]];

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function whole(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d{1,9}$/u.test(value)) return Number(value);
}

function proofField(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[!-~]+$/u.test(value);
}

function passthroughFlag(value: unknown) {
  if (value === true || value === false || value === 0 || value === 1) return value;
}

function getInlineChallenge(data: Json | undefined): GameCheckinChallenge | undefined {
  const gt = data?.gt;
  const challenge = data?.challenge;
  const versions = [data?.captchaVersion, data?.captcha_version].filter(value => value !== undefined);
  if (versions.some(version => version !== 3 && version !== "3" && version !== "v3") ||
      [data?.captchaId, data?.captcha_id].some(id => id !== undefined && id !== gt)) return;
  if (!proofField(gt, 256) || !proofField(challenge, 1024)) return;
  return { captchaVersion: 3, gt, challenge, success: passthroughFlag(data?.success), new_captcha: passthroughFlag(data?.new_captcha) };
}

function riskFlag(data: Json | undefined) {
  return data?.is_risk === true || (whole(data?.is_risk) ?? 0) > 0 ||
    whole(data?.risk_code) === 375 || whole(data?.success) === 1;
}

function requestRole(source: CnGameCheckinSource) {
  const route = Object.hasOwn(routes, source.game) ? routes[source.game] : undefined;
  const { uid, region, gameBiz } = source.role;
  const legacyRole = typeof uid === "string" && /^[1-9]\d{0,19}$/u.test(uid) && (
    (source.game === "nxx" && gameBiz === "nxx_cn" && region === "cn_prod_gf01") ||
    (source.game === "bh3" && gameBiz === "bh3_cn" && isBh3CnCheckinRegion(region))
  );
  // The official binding directory lists both Star Rail regions and only prod_gf_cn for nap_cn.
  const server = source.game === "gs" ? genshinCnRecordRegion(source.role) :
    source.game === "sr" && /^[1-5]\d{8}$/u.test(uid) &&
      (uid.startsWith("5") ? region === "prod_qd_cn" : region === "prod_gf_cn") ? region :
    source.game === "zzz" && /^[1-9]\d{7,8}$/u.test(uid) && region === "prod_gf_cn" ? region :
    legacyRole ? region : undefined;
  if (!route || (gameBiz && gameBiz !== route.biz) || !server) {
    throw new HoyoRequestError("invalid-input", "游戏签到需要当前档案中已确认的国服角色和区服。");
  }
  return { route, uid, region: server };
}

function headersFor(source: CnGameCheckinSource, route: SignRoute) {
  const { account, device } = source;
  const cookie = account.cookie.trim();
  if (!cookie.includes("=") || cookie.length > 16_384 || /[^\x20-\x7e]/u.test(cookie) ||
      [device.id, device.fp].some((value) => value && !/^[A-Za-z0-9_-]{1,128}$/u.test(value))) {
    throw new HoyoRequestError("invalid-input", "当前档案的签到 Cookie 或设备字段无效。");
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = Array.from({ length: 6 }, () => randomAlphabet[randomInt(randomAlphabet.length)]).join("");
  const digest = createHash("md5").update(`salt=${webSalt}&t=${timestamp}&r=${nonce}`).digest("hex");
  const model = device.model && /^[\x20-\x7e]{1,128}$/u.test(device.model) ? device.model : "Android";
  const android = device.androidVersion && /^\d{1,2}(?:\.\d+){0,2}$/u.test(device.androidVersion) ? device.androidVersion : "12";
  const headers = new Headers({
    Accept: "application/json", "Content-Type": "application/json", Cookie: cookie, Origin: origin, Referer: `${origin}/`,
    "x-rpc-app_version": webVersion, "x-rpc-client_type": "5",
    "User-Agent": `Mozilla/5.0 (Linux; Android ${android}; ${model}) AppleWebKit/537.36 Mobile Safari/537.36 miHoYoBBS/${webVersion}`,
    DS: `${timestamp},${nonce},${digest}`,
  });
  if (route.signgame) headers.set("x-rpc-signgame", route.signgame);
  if (device.id) headers.set("x-rpc-device_id", device.id);
  if (device.id && device.fp) headers.set("x-rpc-device_fp", device.fp);
  return headers;
}

function checkResponseRole(data: Json, uid: string, region: string, route: SignRoute) {
  for (const key of ["uid", "game_uid", "role_id"]) {
    if (!Object.hasOwn(data, key)) continue;
    const value = data[key];
    if (value !== uid && !(typeof value === "number" && Number.isSafeInteger(value) && String(value) === uid)) invalidResponse(route);
  }
  for (const key of ["region", "server"]) {
    if (Object.hasOwn(data, key) && data[key] !== region) invalidResponse(route);
  }
  if (Object.hasOwn(data, "game_biz") && data.game_biz !== route.biz) invalidResponse(route);
}

function checkDataRole(data: Json, uid: string, region: string, route: SignRoute) {
  checkResponseRole(data, uid, region, route);
  if (data.role != null) checkResponseRole(object(data.role) ?? invalidResponse(route), uid, region, route);
}

function invalidResponse(route: SignRoute): never {
  throw new HoyoRequestError("response", `官方${route.name}签到响应无效。`);
}

async function requestCheckin(source: CnGameCheckinSource, transport: HoyoTransport, action: "info" | "sign",
  { signal, proof }: GameCheckinSubmitOptions, verifyProfile?: () => Promise<void>) {
  const { route, uid, region } = requestRole(source);
  const url = new URL(`${route.endpoint}/${action}`);
  const identity = { act_id: route.activity, uid, region };
  const params = { ...identity, lang: "zh-cn" };
  const writing = action === "sign";
  const legacyLuna = source.game === "nxx" || source.game === "bh3";
  if (!writing) url.search = new URLSearchParams(params).toString();
  const headers = headersFor(source, route);
  if (proof) {
    if (legacyLuna) throw new HoyoRequestError("invalid-input", `请在米游社官方客户端完成${route.name}签到验证。`);
    if (!writing || !proofField(proof.challenge, 1024) || !proofField(proof.validate, 2048) ||
        proof.seccode !== `${proof.validate}|jordan`) {
      throw new HoyoRequestError("invalid-input", "当前签到的人工验证结果格式无效。");
    }
    headers.set("x-rpc-challenge", proof.challenge);
    headers.set("x-rpc-validate", proof.validate);
    headers.set("x-rpc-seccode", proof.seccode);
  }
  async function guard() {
    if (signal?.aborted) throw new HoyoRequestError("transport", `${route.name}签到已取消。`);
    await verifyProfile?.();
    if (signal?.aborted) throw new HoyoRequestError("transport", `${route.name}签到已取消。`);
  }
  await guard();
  const timeout = AbortSignal.timeout(15_000);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let response: Response;
  try {
    response = await transport(url, {
      method: writing ? "POST" : "GET", headers, body: writing ? JSON.stringify(legacyLuna ? identity : params) : undefined,
      credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: deadline,
    });
  } catch {
    await guard();
    throw new HoyoRequestError("transport", writing ? `${route.name}签到提交结果未确认。` : `${route.name}签到状态暂时无法读取。`);
  }
  const status = response.status;
  const code = response.ok ? "api" : "http";
  const subject = `${route.name}签到`;
  const challenge = response.headers.get("x-rpc-aigis")?.trim();
  if (response.redirected || (challenge && challenge !== "{}") || status === 429 || (!response.ok && status !== 401)) {
    void response.body?.cancel().catch(() => undefined);
    await guard();
    if (status === 429) throw new GameRecordRequestError(subject, "rate-limited", "http", status);
    if (challenge && challenge !== "{}") throw new GameRecordRequestError(subject, "risk", code, status);
    throw new HoyoRequestError("http", `官方${subject}返回 HTTP 错误。`, status);
  }
  const payload = await readGameRecordPayload(response, 128 * 1024, deadline);
  await guard();
  const retcode = whole(payload?.retcode);
  const data = object(payload?.data);
  const message = typeof payload?.message === "string" ? payload.message : "";
  const nestedRisk = legacyLuna ? object(data?.gt_result) : undefined;
  const inlineRisk = retcode === 0 && (riskFlag(data) || riskFlag(nestedRisk));
  if (writing && !legacyLuna && !proof && response.ok && inlineRisk) {
    const inline = getInlineChallenge(data);
    if (inline && data) {
      checkDataRole(data, uid, region, route);
      throw new GameCheckinChallengeError(subject, status, inline);
    }
  }
  if (retcode === 1034 || retcode === 10035 || retcode === 10041 || /验证码|captcha|geetest|风控/iu.test(message) || inlineRisk) {
    throw new GameRecordRequestError(subject, "risk", code, status, retcode);
  }
  if (/频繁|too frequent|rate limit/iu.test(message)) {
    throw new GameRecordRequestError(subject, "rate-limited", code, status, retcode);
  }
  if (retcode === -100) throw new GameRecordRequestError(subject, "expired", code, status, retcode);
  if (status === 401) throw new HoyoRequestError("http", `官方${subject}拒绝请求。`, status, retcode);
  if (retcode === undefined || deadline.aborted) invalidResponse(route);
  if (writing && retcode === -5003) {
    if (source.game === "bh3" && payload?.data != null && !data) invalidResponse(route);
    if (legacyLuna && data) checkDataRole(data, uid, region, route);
    return { route, already: true as const };
  }
  if (retcode !== 0) throw new HoyoRequestError("api", `官方${subject}拒绝请求。`, status, retcode);
  if (legacyLuna && payload?.data != null && !data) invalidResponse(route);
  if (data) checkDataRole(data, uid, region, route);
  return { route, data };
}

export async function readCnGameCheckinInfo(source: CnGameCheckinSource, transport: HoyoTransport,
  options: GameCheckinOptions = {}, verifyProfile?: () => Promise<void>): Promise<CnGameCheckinInfo> {
  const { route, data } = await requestCheckin(source, transport, "info", options, verifyProfile);
  if (!data || typeof data.is_sign !== "boolean" || (data.first_bind !== undefined && typeof data.first_bind !== "boolean")) invalidResponse(route);
  const totalSignDays = whole(data.total_sign_day);
  if (data.total_sign_day !== undefined && (totalSignDays === undefined || totalSignDays < 0 || totalSignDays > 31)) invalidResponse(route);
  return { signed: data.is_sign, firstBind: data.first_bind === true, ...(totalSignDays !== undefined && { totalSignDays }) };
}

/** A POST acknowledgment is only evidence to proceed to the independent status check. */
export async function submitCnGameCheckin(source: CnGameCheckinSource, transport: HoyoTransport,
  options: GameCheckinSubmitOptions = {}, verifyProfile?: () => Promise<void>) {
  const result = await requestCheckin(source, transport, "sign", options, verifyProfile);
  return result.already ? "already" as const : "accepted" as const;
}
