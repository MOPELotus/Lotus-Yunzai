import { getDefaultCaptchaSolver, type CaptchaChallenge, type CaptchaProof } from "./captcha.ts";
import { setTimeout as delay } from "node:timers/promises";
import type { ProfileAccountContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { readGameRecordPayload } from "./game-record.ts";

const shopOrigin = "https://bbs-api.miyoushe.com";
const addressOrigin = "https://api-takumi.miyoushe.com";
const productOrigin = "https://api-takumi.mihoyo.com";
const productPage = "https://user.mihoyo.com";
const webOrigin = "https://webstatic.miyoushe.com";
const appVersion = "2.118.1";
const app = { app_id: 1, point_sn: "myb" };
const idPattern = /^[1-9]\d{0,19}$/u;
const codePattern = /^[a-zA-Z0-9_]{1,32}$/u;
const cookieValue = /^[!#-:<-\[\]-~]{1,2048}$/u;
const cookieKeys = new Set(["cookie_token", "account_id", "cookie_token_v2", "account_id_v2", "account_mid_v2",
  "ltuid", "ltuid_v2", "stuid"]);
const responseLimit = 256 * 1024;
type Classification = "expired" | "verification" | "rate-limited" | "failed";
type Verify = () => Promise<void>;
type Json = Record<string, unknown>;
export type MiyousheShopExchangeResult = "succeeded" | "failed" | "verification" | "rate-limited" | "unknown" | "missed";

export interface MiyousheShopOrder {
  readonly goodsId: string;
  readonly type: 1 | 2;
  readonly gameBiz: string;
  readonly role: { readonly uid: string; readonly region: string; readonly gameBiz: string } | null;
  readonly addressId: string;
}

interface ShopManualChallenge {
  readonly captchaVersion: 4;
  readonly captchaId: string;
  readonly riskType?: string;
}

interface ShopManualProof {
  readonly captchaVersion: 4;
  readonly captchaId: string;
  readonly lotNumber: string;
  readonly captchaOutput: string;
  readonly passToken: string;
  readonly genTime: string;
}

export interface ShopManualVerification {
  readonly allowManual?: boolean;
  readonly waitForProof: (challenge: ShopManualChallenge, signal: AbortSignal) => Promise<ShopManualProof | undefined>;
  readonly prepareResume: () => Promise<void>;
}

export class MiyousheExchangeError extends Error {
  constructor(readonly status: 400 | 409 | 429 | 502, readonly reason: Classification | "invalid", message: string) { super(message); }
}

function invalid(message: string): never { throw new MiyousheExchangeError(400, "invalid", message); }

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function accountCookie({ account }: ProfileAccountContext) {
  const uid = account.stuid || account.ltuid;
  const invalidCookie = "当前档案缺少有效的商城 Cookie，请重新登录。";
  if (!idPattern.test(uid) || (account.stuid && account.ltuid && account.stuid !== account.ltuid)) invalid(invalidCookie);
  const fields = new Map<string, string>();
  for (const item of account.cookie.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (!cookieKeys.has(key)) continue;
    const value = item.slice(separator + 1).trim();
    if (!cookieValue.test(value) || (fields.has(key) && fields.get(key) !== value)) invalid(invalidCookie);
    fields.set(key, value);
  }
  for (const key of ["account_id", "account_id_v2", "ltuid", "ltuid_v2", "stuid"]) {
    if (fields.has(key) && fields.get(key) !== uid) invalid(invalidCookie);
  }
  const v2 = fields.get("cookie_token_v2");
  if (v2) {
    const mid = fields.get("account_mid_v2");
    if (!v2.startsWith("v2_") || !mid || fields.get("account_id_v2") !== uid || (account.mid && account.mid !== mid)) invalid(invalidCookie);
    return `cookie_token_v2=${v2}; account_id_v2=${uid}; account_mid_v2=${mid}`;
  }
  const v1 = fields.get("cookie_token");
  if (!v1 || v1.startsWith("v2_") || fields.get("account_id") !== uid) invalid(invalidCookie);
  return `cookie_token=${v1}; account_id=${uid}`;
}

function requestHeaders(profile: ProfileAccountContext, writing: boolean) {
  const { device } = profile;
  const valid = (value: string | undefined) => !!value && /^[\x20-\x7e]{1,160}$/u.test(value);
  const model = valid(device.model) ? device.model : "Android";
  const android = /^\d{1,2}(?:\.\d+){0,2}$/u.test(device.androidVersion || "") ? device.androidVersion : "12";
  const headers = new Headers({
    Accept: "application/json",
    Cookie: accountCookie(profile),
    Origin: webOrigin,
    Referer: `${webOrigin}/`,
    "User-Agent": `Mozilla/5.0 (Linux; Android ${android}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 miHoYoBBS/${appVersion}`,
    "x-rpc-client_type": writing ? "1" : "5",
  });
  if (valid(device.id)) headers.set("x-rpc-device_id", device.id);
  if (writing) {
    if (!valid(device.id) || !valid(device.fp)) invalid("请先核验当前档案绑定的设备。");
    headers.set("Content-Type", "application/json;charset=utf-8");
    headers.set("x-rpc-app_version", appVersion);
    headers.set("x-rpc-channel", "appstore");
    headers.set("x-rpc-verify_key", "bll8iq97cem8");
    headers.set("x-rpc-device_fp", encodeURIComponent(device.fp));
    headers.set("x-rpc-device_model", model);
    headers.set("x-rpc-device_name", encodeURIComponent(device.name || model));
    headers.set("x-rpc-sys_version", android);
  }
  return headers;
}

function classification(retcode: number, status: number, message: unknown): Classification {
  if (status === 429 || retcode === 429 || (typeof message === "string" && /频繁|频率限制|请求过快|操作太快/u.test(message))) return "rate-limited";
  if (retcode === 1028 || retcode === 1034) return "verification";
  if (status === 401 || [-100, -10000, 10001, 10101, 10102, 10103].includes(retcode)) return "expired";
  return "failed";
}

function readError(reason: Classification = "failed") {
  switch (reason) {
    case "rate-limited": return new MiyousheExchangeError(429, reason, "商城请求频繁，请稍后再试。");
    case "verification": return new MiyousheExchangeError(409, reason, "请在米游社官方客户端完成验证后重试。");
    case "expired": return new MiyousheExchangeError(409, reason, "当前档案的商城 Cookie 已失效，请重新登录。");
    default: return new MiyousheExchangeError(502, reason, "暂时无法读取兑换所需的账号信息。");
  }
}

function retcodeOf(payload: Json | undefined) {
  return typeof payload?.retcode === "number" && Number.isSafeInteger(payload.retcode) ? payload.retcode : undefined;
}

async function request(transport: HoyoTransport, url: URL, profile: ProfileAccountContext,
  signal?: AbortSignal, verify?: Verify, body?: string, headers = requestHeaders(profile, body !== undefined),
  retryRead = false) {
  signal?.throwIfAborted();
  await verify?.();
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(10_000);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const options: RequestInit = {
    method: body === undefined ? "GET" : "POST", headers, credentials: "omit", redirect: "error",
    referrerPolicy: "no-referrer", signal: deadline,
    ...(body === undefined ? {} : { body }),
  };
  let response: Response | undefined;
  const attempts = retryRead && body === undefined ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await delay(150 * attempt, undefined, { signal: deadline });
      await verify?.();
      deadline.throwIfAborted();
    }
    response = await transport(url, options).catch(() => undefined);
    if (response || deadline.aborted) break;
  }
  if (!response || response.redirected || (response.url && response.url !== url.href)) return;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, payload: undefined };
  }
  return { status: response.status, payload: await readGameRecordPayload(response, responseLimit, deadline) };
}

function submitResult(result: Awaited<ReturnType<typeof request>>): MiyousheShopExchangeResult {
  if (result?.status === 429) return "rate-limited";
  const code = retcodeOf(result?.payload);
  if (result?.status !== 200 || code === undefined) return "unknown";
  if (code === 0) return "succeeded";
  const rejected = classification(code, result.status, result.payload?.message);
  return rejected === "expired" ? "failed" : rejected;
}

function verifiedField(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && /^[!-~]+$/u.test(value);
}

async function verifyShopChallenge(transport: HoyoTransport, profile: ProfileAccountContext, code: 1028 | 1034,
  cookie: string, signal: AbortSignal, verify: Verify, manual: ShopManualVerification) {
  const headers = new Headers({ Accept: "application/json, text/plain, */*", Cookie: cookie,
    Origin: webOrigin, Referer: `${webOrigin}/` });
  async function createChallenge(): Promise<ShopManualChallenge> {
    const create = new URL("/misc/wapi/createVerification", shopOrigin);
    create.search = new URLSearchParams({ point_sn: app.point_sn, is_high: String(code === 1034), captcha_version: "v4" }).toString();
    const created = await request(transport, create, profile, signal, verify, undefined, headers);
    signal.throwIfAborted();
    await verify();
    const data = object(created?.payload?.data);
    if (created?.status !== 200 || retcodeOf(created.payload) !== 0 || !verifiedField(data?.captcha_id, 256)) {
      throw new Error("商城验证码申请未完成。");
    }
    return { captchaVersion: 4, captchaId: data.captcha_id,
      ...(verifiedField(data.risk_type, 8192) && { riskType: data.risk_type }) };
  }
  async function accept(proof: CaptchaProof, challenge: CaptchaChallenge) {
    if (challenge.captchaVersion !== 4 || !("captchaId" in proof) || proof.captchaVersion !== 4 ||
        proof.captchaId !== challenge.captchaId ||
        ![proof.lotNumber, proof.captchaOutput, proof.passToken].every(value => verifiedField(value, 2048)) ||
        typeof proof.genTime !== "string" || !/^\d{1,32}$/u.test(proof.genTime)) return { accepted: false as const };
    const validate = new URL("/misc/wapi/verifyVerfication", shopOrigin);
    validate.search = new URLSearchParams({ captcha_version: "v4", lot_number: proof.lotNumber,
      captcha_output: proof.captchaOutput, pass_token: proof.passToken, gen_time: proof.genTime }).toString();
    const signed = new Headers(headers);
    signed.set("Content-Type", "application/json;charset=utf-8");
    const result = await request(transport, validate, profile, signal, verify, JSON.stringify({ point_sn: app.point_sn }), signed);
    signal.throwIfAborted();
    await verify();
    const retcode = retcodeOf(result?.payload);
    const rpcChallenge = object(result?.payload?.data)?.challenge;
    if (result?.status !== 200 || retcode === undefined || retcode === 10041 ||
        [-100, 10001, 10101, 10102, 10103].includes(retcode)) throw new Error("商城验证码校验未完成。");
    if (classification(retcode, result.status, result.payload?.message) === "rate-limited" || retcode === -10000) {
      throw new Error("商城验证码业务账号或频率限制，停止重试。");
    }
    if (retcode !== 0) return { accepted: false as const };
    if (!verifiedField(rpcChallenge, 2048)) throw new Error("商城验证码校验响应无效。");
    return { accepted: true as const, value: rpcChallenge };
  }
  const solver = getDefaultCaptchaSolver();
  if (solver) {
    const solved = await solver.run<string>({ signal, verify,
      context: { qq: profile.qq, profileId: profile.profileId }, allowManual: manual.allowManual !== false,
      challenge: createChallenge, accept,
      manualProof: (challenge, scope) => challenge.captchaVersion === 4 ? manual.waitForProof(challenge, scope) : Promise.resolve(undefined),
    });
    return solved.ok ? solved.value : undefined;
  }
  const challenge = await createChallenge();
  const proof = await manual.waitForProof(challenge, signal);
  if (!proof) return;
  const result = await accept(proof, challenge);
  return result.accepted ? result.value : undefined;
}

async function read(transport: HoyoTransport, url: URL, profile: ProfileAccountContext,
  signal?: AbortSignal, verify?: Verify, headers?: Headers,
) {
  const result = await request(transport, url, profile, signal, verify, undefined, headers, true);
  signal?.throwIfAborted();
  await verify?.();
  signal?.throwIfAborted();
  const retcode = retcodeOf(result?.payload);
  if (result?.status !== 200 || retcode !== 0) {
    throw readError(classification(retcode ?? 0, result?.status ?? 0, result?.payload?.message));
  }
  const data = object(result.payload?.data);
  if (!data) throw readError();
  return data;
}

export async function readMiyousheShopAccountQuota(transport: HoyoTransport, profile: ProfileAccountContext, goodsId: string,
  signal?: AbortSignal, verify?: Verify,
) {
  if (!idPattern.test(goodsId)) invalid("商品编号无效。");
  const url = new URL("/mall/v1/web/goods/detail", productOrigin);
  url.search = new URLSearchParams({ app_id: String(app.app_id), point_sn: app.point_sn, goods_id: goodsId }).toString();
  const headers = requestHeaders(profile, false);
  headers.set("Origin", productPage);
  headers.set("Referer", productPage + "/");
  const data = await read(transport, url, profile, signal, verify, headers);
  const count = (input: unknown) => {
    const value = typeof input === "string" && /^\d{1,16}$/u.test(input) ? Number(input) : input;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  };
  const cycle = data.account_cycle_type;
  const limit = count(data.account_cycle_limit);
  const used = count(data.account_exchange_num);
  if (String(data.goods_id) !== goodsId || typeof cycle !== "string" || cycle === "not_limit" ||
      !codePattern.test(cycle) || limit === undefined || limit < 1 || used === undefined) return;
  return { limit, used, cycle };
}

export async function readMiyousheShopBalance(transport: HoyoTransport, profile: ProfileAccountContext,
  signal?: AbortSignal, verify?: Verify) {
  const url = new URL("/common/homutreasure/v1/web/user/point", shopOrigin);
  url.searchParams.set("app_id", String(app.app_id));
  url.searchParams.set("point_sn", app.point_sn);
  const { points } = await read(transport, url, profile, signal, verify);
  const balance = typeof points === "string" && /^\d{1,16}$/u.test(points) ? Number(points) : points;
  if (typeof balance !== "number" || !Number.isSafeInteger(balance) || balance < 0) throw readError();
  return balance;
}

export async function readMiyousheShopAddresses(transport: HoyoTransport, profile: ProfileAccountContext,
  signal?: AbortSignal, verify?: Verify) {
  const url = new URL("/account/address/list", addressOrigin);
  url.searchParams.set("point_sn", app.point_sn);
  const { list } = await read(transport, url, profile, signal, verify);
  if (!Array.isArray(list) || list.length > 100) throw readError();
  const addresses = new Map<string, string>();
  for (const value of list) {
    const address = object(value);
    const id = typeof address?.id === "string" ? address.id
      : typeof address?.id === "number" && Number.isSafeInteger(address.id) ? String(address.id) : "";
    if (!idPattern.test(id) || !Number.isSafeInteger(Number(id)) || addresses.has(id)) throw readError();
    const name = typeof address?.connect_name === "string"
      ? address.connect_name.replace(/[\p{Cc}\p{Cf}*]/gu, "").trim() : "";
    const mobile = typeof address?.connect_mobile === "string" ? address.connect_mobile.trim() : "";
    const lastFour = /^\d{4}$/u.test(mobile.slice(-4)) ? mobile.slice(-4) : "";
    addresses.set(id, `${Array.from(name)[0] ?? "收"}** ****${lastFour}`);
  }
  return Array.from(addresses, ([id, label]) => ({ id, label }));
}

export async function submitMiyousheShopExchange(transport: HoyoTransport, profile: ProfileAccountContext,
  order: MiyousheShopOrder, signal?: AbortSignal, verify?: Verify,
  manual?: ShopManualVerification, firstDispatchAllowed?: () => boolean): Promise<MiyousheShopExchangeResult> {
  if (!idPattern.test(order.goodsId)) invalid("兑换商品编号无效。");
  let body;
  if (order.type === 1 && !order.role && idPattern.test(order.addressId) && Number.isSafeInteger(Number(order.addressId))) {
    body = { ...app, goods_id: order.goodsId, exchange_num: 1, address_id: Number(order.addressId) };
  } else if (order.type === 2 && !order.addressId && order.role && idPattern.test(order.role.uid) &&
      codePattern.test(order.role.region) && codePattern.test(order.gameBiz) && order.role.gameBiz === order.gameBiz) {
    body = { ...app, goods_id: order.goodsId, exchange_num: 1, address_id: 0,
      uid: order.role.uid, region: order.role.region, game_biz: order.gameBiz };
  } else invalid("兑换目标与商品类型不匹配。");
  const endpoint = new URL("/common/homushop/v1/web/goods/exchange", shopOrigin);
  const payload = JSON.stringify(body);
  const headers = requestHeaders(profile, true);
  let missed = false;
  const first: HoyoTransport = async (url, init) => {
    if (firstDispatchAllowed && !firstDispatchAllowed()) {
      missed = true;
      throw new Error("商城已关窗，未提交。");
    }
    return transport(url, init);
  };
  const result = await request(first, endpoint, profile, signal, verify, payload, headers);
  if (missed) return "missed";
  const initial = submitResult(result);
  const code = retcodeOf(result?.payload);
  const cookie = headers.get("Cookie");
  if (initial !== "verification" || (code !== 1028 && code !== 1034) || !manual || !signal || !verify || !cookie) return initial;
  // The first request was explicitly refused. Until the next dispatch starts,
  // any failure still leaves a known non-purchase.
  try {
    const rpcChallenge = await verifyShopChallenge(transport, profile, code, cookie, signal, verify, manual);
    if (!rpcChallenge) return initial;
    await manual.prepareResume();
    headers.set("x-rpc-challenge", rpcChallenge);
  } catch {
    return initial;
  }
  let dispatched = false;
  const resume: HoyoTransport = (url, init) => {
    dispatched = true;
    return transport(url, init);
  };
  try {
    return submitResult(await request(resume, endpoint, profile, signal, verify, payload, headers));
  } catch {
    return dispatched ? "unknown" : initial;
  }
}
