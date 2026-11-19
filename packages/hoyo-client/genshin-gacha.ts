import { createHash, randomInt } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";

export const genshinGachaPools = [
  { type: 301, name: "角色" }, { type: 302, name: "武器" }, { type: 500, name: "集录" }, { type: 200, name: "常驻" },
] as const;

export type GenshinGachaPool = typeof genshinGachaPools[number]["type"];
type RecordPool = `${GenshinGachaPool | 400}`;

export interface GenshinGachaRow extends Record<string, unknown> {
  readonly id: string;
  readonly uid: string;
  readonly gacha_type: RecordPool;
}

export interface GenshinGachaOptions {
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
  readonly maxPages?: number;
}

const authOrigin = "https://api-takumi.mihoyo.com";
const gachaOrigin = "https://public-operation-hk4e.mihoyo.com";
const appVersion = "2.118.1";
const signingSalt = "7a047e46eadd8693f09513e55bdf6bd8";
const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
const gameBiz = "hk4e_cn";
const authApp = "webview_gacha";
const uidFields = ["stuid", "uid", "ltuid", "ltuid_v2", "account_id", "account_id_v2"];
const midFields = ["mid", "stmid_v2", "ltmid_v2", "account_mid_v2"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimal(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string" || !/^\d{1,40}$/u.test(value)) return;
  const canonical = value.replace(/^0+/u, "");
  return canonical || undefined;
}

function cnRegion({ game, role: { uid, gameBiz: roleBiz, region: explicit } }: ProfileRequestContext) {
  const uidRegion = /^[125]\d{8}$/u.test(uid) ? uid.startsWith("5") ? "cn_qd01" : "cn_gf01" : undefined;
  const region = explicit.trim() || uidRegion;
  if (game !== "gs" || !/^[1-5]\d{8}$/u.test(uid) || (roleBiz && roleBiz !== gameBiz) ||
      (region !== "cn_gf01" && region !== "cn_qd01") || (uid.startsWith("5") !== (region === "cn_qd01"))) {
    throw new HoyoRequestError("invalid-input", "原神官方抽卡仅支持档案中已确认的国服角色与区服。");
  }
  return region;
}

function parseCookie(cookie: string) {
  return cookie.split(";").flatMap((field) => {
    const separator = field.indexOf("=");
    return separator > 0 ? [[field.slice(0, separator).trim(), field.slice(separator + 1).trim()] as const] : [];
  });
}

function stokenCookie({ account }: ProfileRequestContext) {
  const { stoken, stokenCookie, cookie, stuid, ltuid, mid } = account;
  const login = parseCookie(stokenCookie);
  const fields = [...login, ...parseCookie(cookie)];
  const ids = new Set([stuid, ltuid, ...fields.filter(([key]) => uidFields.includes(key)).map(([, value]) => value)].filter(Boolean));
  const mids = new Set([mid, ...fields.filter(([key]) => midFields.includes(key)).map(([, value]) => value)].filter(Boolean));
  const tokens = new Set(login.filter(([key]) => key === "stoken").map(([, value]) => value));
  const [accountId] = ids;
  const [token] = tokens;
  if (!stokenCookie.trim() || /[\u0000-\u001f\u007f]/u.test(stokenCookie) || ids.size !== 1 ||
      !accountId || !/^[1-9]\d*$/u.test(accountId) || mids.size > 1 || tokens.size !== 1 || !token ||
      (stoken && stoken !== token) || (token.startsWith("v2_") && !mids.size)) {
    throw new HoyoRequestError("invalid-input", "原神抽卡需要归属一致的档案登录凭据。");
  }
  return stokenCookie;
}

function authHeaders(cookie: string, { device }: ProfileRequestContext) {
  const time = Math.floor(Date.now() / 1000);
  const nonce = Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join("");
  const sign = createHash("md5").update(`salt=${signingSalt}&t=${time}&r=${nonce}`).digest("hex");
  const headers = new Headers({
    Cookie: cookie, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "okhttp/4.9.3",
    "x-rpc-app_version": appVersion, "x-rpc-client_type": "5", "x-rpc-channel": "mihoyo",
    "x-rpc-sys_version": device.androidVersion || "12", Referer: "https://app.mihoyo.com", Origin: "https://webstatic.mihoyo.com",
    "x-rpc-device_id": device.id || "00000000000000000000000000000000",
    "x-rpc-device_name": device.name || "Lotus Device", "x-rpc-device_model": device.model || "Lotus",
    DS: `${time},${nonce},${sign}`,
  });
  if (device.id && device.fp) headers.set("x-rpc-device_fp", device.fp);
  return headers;
}

function parseRow(row: unknown, uid: string, type: GenshinGachaPool): GenshinGachaRow {
  if (!record(row)) throw new HoyoRequestError("response", "原神卡池包含无效记录。");
  const id = decimal(row.id);
  const gachaType = typeof row.gacha_type === "string" || typeof row.gacha_type === "number" ? String(row.gacha_type) : "";
  if (!id || (typeof row.uid !== "string" && typeof row.uid !== "number") || String(row.uid) !== uid ||
      (gachaType !== String(type) && !(type === 301 && gachaType === "400"))) {
    throw new HoyoRequestError("response", "原神卡池返回了无效编号、账号或分类的记录。");
  }
  return { ...row, id, uid, gacha_type: gachaType as RecordPool };
}

export class GenshinAuthKeyRequestError extends HoyoRequestError {}

export async function readGenshinGacha(
  source: ProfileRequestContext,
  transport: HoyoTransport,
  { signal, intervalMs = 1_000, maxPages = 1_000 }: GenshinGachaOptions = {},
  verifyProfile?: () => Promise<void>,
) {
  const region = cnRegion(source);
  const uid = source.role.uid;
  const cookie = stokenCookie(source);
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647 ||
      !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
    throw new HoyoRequestError("invalid-input", "原神抽卡请求间隔或分页上限无效。");
  }

  async function guard() {
    if (signal?.aborted) throw new HoyoRequestError("transport", "原神抽卡请求已取消。");
    await verifyProfile?.();
    if (signal?.aborted) throw new HoyoRequestError("transport", "原神抽卡请求已取消。");
  }

  async function request(endpoint: URL, auth: boolean, init: RequestInit) {
    await guard();
    const timeout = AbortSignal.timeout(auth ? 20_000 : 30_000);
    let response: Response;
    try {
      response = await transport(endpoint, { ...init, redirect: "error", credentials: "omit",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch {
      throw new HoyoRequestError("transport", "原神抽卡请求未完成。");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HoyoRequestError("http", "原神抽卡接口返回 HTTP 错误。", response.status);
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const code = record(payload) ? payload.retcode : undefined;
    const retcode = auth && typeof code === "string" && /^-?\d{1,10}$/u.test(code) ? Number(code) : code;
    if (typeof retcode !== "number" || !Number.isSafeInteger(retcode) || !record(payload)) {
      throw new HoyoRequestError("response", "原神抽卡接口响应格式有误。");
    }
    if (retcode !== 0) {
      const ServiceError = auth ? GenshinAuthKeyRequestError : HoyoRequestError;
      throw new ServiceError("api", "原神抽卡接口拒绝请求。", response.status, retcode);
    }
    if (!record(payload.data)) throw new HoyoRequestError("response", "原神抽卡响应缺少有效数据。");
    return payload.data;
  }

  let headers: Headers;
  try { headers = authHeaders(cookie, source); }
  catch { throw new HoyoRequestError("invalid-input", "原神抽卡的档案设备信息无效。"); }
  const credential = await request(new URL("/binding/api/genAuthKey", authOrigin), true, {
    method: "POST", headers,
    body: JSON.stringify({ auth_appid: authApp, game_biz: gameBiz, game_uid: Number(uid), region }),
  });
  const authkey = credential.authkey;
  if (typeof authkey !== "string" || !authkey || authkey.length > 4096 || /[\u0000-\u0020\u007f]/u.test(authkey) ||
      (credential.game_uid !== undefined && decimal(credential.game_uid) !== uid) ||
      (credential.region !== undefined && credential.region !== region) ||
      (credential.game_biz !== undefined && credential.game_biz !== gameBiz)) {
    throw new HoyoRequestError("response", "原神抽卡登录响应的凭据或角色身份无效。");
  }

  const baseQuery = { authkey_ver: "1", sign_type: "2", auth_appid: authApp, init_type: "301",
    gacha_id: "fecafa7b6560db5f3182222395d88aaa6aaac1bc", timestamp: String(Math.floor(Date.now() / 1000)),
    lang: "zh-cn", device_type: "mobile", plat_type: "ios", region, authkey, game_biz: gameBiz, size: "20" };
  async function readPool(type: GenshinGachaPool) {
    const rows: GenshinGachaRow[] = [];
    let cursor = "0";
    for (let page = 1; page <= maxPages; page++) {
      if (intervalMs) {
        try { await wait(intervalMs, undefined, { signal }); }
        catch { throw new HoyoRequestError("transport", "原神抽卡请求已取消。"); }
      }
      const endpoint = new URL("/gacha_info/api/getGachaLog", gachaOrigin);
      endpoint.search = new URLSearchParams({ ...baseQuery, gacha_type: String(type), page: String(page), end_id: cursor }).toString();
      const data = await request(endpoint, false, { method: "GET", headers: { Accept: "application/json" } });
      if ((data.region !== undefined && data.region !== region) || (data.uid !== undefined && decimal(data.uid) !== uid)) {
        throw new HoyoRequestError("response", "原神抽卡响应的账号或区服与档案不一致。");
      }
      if (!Array.isArray(data.list) || data.list.length > 20) {
        throw new HoyoRequestError("response", "原神抽卡响应的分页列表无效。");
      }
      if (!data.list.length) return rows;
      const batch = data.list.map((row) => parseRow(row, uid, type));
      const next = batch[batch.length - 1]!.id;
      if (cursor !== "0" && BigInt(next) >= BigInt(cursor)) {
        throw new HoyoRequestError("response", "原神抽卡响应的下一页游标无效。");
      }
      rows.push(...batch);
      cursor = next;
    }
    throw new HoyoRequestError("response", "原神抽卡列表超过分页上限，本次未取完。");
  }

  const pools: { type: GenshinGachaPool; name: string; records: GenshinGachaRow[] }[] = [];
  for (const pool of genshinGachaPools) pools.push({ ...pool, records: await readPool(pool.type) });
  await guard();
  return { uid, region, pools };
}
