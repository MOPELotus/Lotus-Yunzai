import { setTimeout as wait } from "node:timers/promises";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";
import { gachaAuthHeaders, starRailLedgerStokenCookie } from "./gacha-auth-request.ts";

const types = { dreams: "Dreams", stellar: "Stellar", power: "Power", relic: "Relic" } as const;
const origin = "https://api-takumi.mihoyo.com";
const gameBiz = "hkrpg_cn", authAppid = "csc", pageSize = 10;
const expired = new Set([-100, -101, -105, 10001, 10101, 10102, 10103]);
const risk = new Set([1034, 10035, 10041]);
export type StarRailLedgerKind = keyof typeof types;
export interface StarRailLedgerOptions {
  readonly kind: StarRailLedgerKind;
  readonly page: number;
  readonly signal?: AbortSignal;
}
export interface StarRailOnlineOptions {
  readonly signal?: AbortSignal;
  readonly maxPages?: number;
  readonly intervalMs?: number;
}

export interface StarRailPowerRecovery {
  readonly time: string;
  readonly count: number;
}

export interface StarRailLedgerRow {
  readonly time: string;
  readonly count: number;
  readonly reason: string;
}

type Json = Record<string, unknown>;
function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function integer(value: unknown) {
  const number = typeof value === "string" && /^-?\d{1,16}$/u.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : undefined;
}

function displayText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && value.isWellFormed() &&
    !!value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function matchingRole(record: Json, uid: string, region: string) {
  return ["uid", "role_id", "game_uid"].every(key => !Object.hasOwn(record, key) || String(record[key]) === uid) &&
    ["region", "server"].every(key => !Object.hasOwn(record, key) || record[key] === region) &&
    (!Object.hasOwn(record, "game_biz") || record.game_biz === gameBiz);
}

async function openStarRailLedger(source: ProfileRequestContext, transport: HoyoTransport,
  signal?: AbortSignal, verifyProfile?: () => Promise<void>) {
  const { uid, region } = source.role;
  if (source.game !== "sr" || !/^[1-5]\d{8}$/u.test(uid) || source.role.gameBiz !== gameBiz ||
      region !== (uid.startsWith("5") ? "prod_qd_cn" : "prod_gf_cn")) {
    throw new HoyoRequestError("invalid-input", "星铁流水仅支持当前档案已同步的国服角色。");
  }
  const cookie = starRailLedgerStokenCookie(source);
  let headers: Headers;
  try {
    headers = gachaAuthHeaders(cookie, source);
    headers.set("Origin", "https://act.mihoyo.com");
    headers.set("Referer", "https://act.mihoyo.com/");
    headers.set("x-rpc-client_type", "2");
    headers.set("x-rpc-channel", "miyousheluodi");
    if (!source.device.id) headers.delete("x-rpc-device_id");
  } catch {
    throw new HoyoRequestError("invalid-input", "星铁流水的档案设备信息无效。");
  }

  async function guard() {
    signal?.throwIfAborted();
    await verifyProfile?.();
    signal?.throwIfAborted();
  }

  async function request(url: URL, init: RequestInit, authorizing: boolean) {
    const action = authorizing ? "星铁流水授权" : "星铁流水查询";
    await guard();
    const timeout = AbortSignal.timeout(15_000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await transport(url, { ...init, redirect: "error", credentials: "omit", signal: deadline });
    } catch {
      await guard();
      throw new HoyoRequestError("transport", `官方${action}请求未完成。`);
    }
    const verification = response.headers.get("x-rpc-aigis")?.trim();
    if (response.redirected || (response.url && response.url !== url.href) ||
        (!response.ok && response.status !== 401) || (verification && verification !== "{}")) {
      await response.body?.cancel().catch(() => undefined);
      await guard();
      const message = response.status === 429 ? `官方${action}请求过于频繁，请稍后重试。` :
        verification && verification !== "{}" ? `官方${action}要求验证，请在官方客户端处理后重试。` :
          `官方${action}接口返回 HTTP 错误。`;
      throw new HoyoRequestError("http", message, response.status);
    }
    const payload = await readGameRecordPayload(response, authorizing ? 32 * 1024 : 64 * 1024, deadline);
    await guard();
    if (timeout.aborted) throw new HoyoRequestError("transport", `官方${action}超时。`);
    const code = integer(payload?.retcode);
    if (code !== undefined && risk.has(code)) {
      throw new HoyoRequestError("api", `官方${action}要求验证，请在官方客户端处理后重试。`, response.status, code);
    }
    if (response.status === 401 || (code !== undefined && expired.has(code))) {
      throw new HoyoRequestError("api", authorizing ? "档案登录已失效，请重新登录后查询星铁流水。" :
        "星铁流水临时授权已失效，请重新查询。", response.status, code);
    }
    if (code === undefined) throw new HoyoRequestError("response", `官方${action}响应格式无效。`);
    if (code !== 0) throw new HoyoRequestError("api", `官方${action}拒绝请求。`, response.status, code);
    const data = object(payload?.data);
    if (!data || !matchingRole(data, uid, region) || !matchingRole(object(data.role) ?? {}, uid, region)) {
      throw new HoyoRequestError("response", `官方${action}响应的档案身份或数据无效。`);
    }
    return data;
  }

  const ticket = await request(new URL("/binding/api/genAuthKey", origin), {
    method: "POST", headers, body: JSON.stringify({ auth_appid: authAppid, game_biz: gameBiz, game_uid: Number(uid), region }),
  }, true);
  const authkey = ticket.authkey;
  if (typeof authkey !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(authkey) ||
      (Object.hasOwn(ticket, "auth_appid") && ticket.auth_appid !== authAppid) ||
      (Object.hasOwn(ticket, "authkey_ver") && integer(ticket.authkey_ver) !== 1) ||
      (Object.hasOwn(ticket, "sign_type") && integer(ticket.sign_type) !== 2)) {
    throw new HoyoRequestError("response", "星铁流水临时授权无效。");
  }

  return async function readPage(kind: StarRailLedgerKind, page: number, size: number) {
    const url = new URL(`/common/hkrpg_self_help_inquiry/${types[kind]}/GetList`, origin);
    url.search = new URLSearchParams({ sign_type: "2", auth_appid: authAppid, authkey_ver: "1", win_direction: "portrait",
      page_id: "4", bbs_auth_required: "true", bbs_game_role_required: gameBiz, app_client: "bbs", game_biz: gameBiz,
      lang: "zh-cn", authkey, page: String(page), page_size: String(size) }).toString();
    const data = await request(url, { method: "GET" }, false);
    if ((Object.hasOwn(data, "page") && integer(data.page) !== page) ||
        !Array.isArray(data.list) || data.list.length > size) {
      throw new HoyoRequestError("response", "官方星铁流水响应的页码或记录无效。");
    }
    return data.list.map(entry => {
      const row = object(entry);
      const count = integer(row?.add_num);
      if (!row || count === undefined || !matchingRole(row, uid, region)) {
        throw new HoyoRequestError("response", "官方星铁流水含无效记录。");
      }
      return { count, time: row.time, action: row.action, id: row.id };
    });
  };
}

export async function readStarRailLedger(source: ProfileRequestContext, transport: HoyoTransport,
  { kind, page, signal }: StarRailLedgerOptions, verifyProfile?: () => Promise<void>) {
  if (!Object.hasOwn(types, kind) || !Number.isSafeInteger(page) || page < 1 || page > 999999) {
    throw new HoyoRequestError("invalid-input", "星铁流水类型或页码无效。");
  }
  const readPage = await openStarRailLedger(source, transport, signal, verifyProfile);
  const rows: StarRailLedgerRow[] = [];
  for (const row of await readPage(kind, page, pageSize)) {
    if (row.count <= (kind === "power" ? 1 : 0)) continue;
    if (!displayText(row.time, 40) || !displayText(row.action, 120)) {
      throw new HoyoRequestError("response", "官方星铁流水含无效记录。");
    }
    rows.push({ count: row.count, time: row.time, reason: row.action });
  }
  return { rows };
}


export async function readStarRailOnline(source: ProfileRequestContext, transport: HoyoTransport,
  { signal, maxPages = 120, intervalMs = 500 }: StarRailOnlineOptions, verifyProfile?: () => Promise<void>) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 240 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 5_000) {
    throw new HoyoRequestError("invalid-input", "星铁在线时长的翻页或间隔参数无效。");
  }
  const readPage = await openStarRailLedger(source, transport, signal, verifyProfile);
  const recoveries: StarRailPowerRecovery[] = [];
  const pages = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const rows = await readPage("power", page, 50);
    if (!rows.length) return { recoveries, complete: true };
    const signature = JSON.stringify(rows.map(({ id, time, action, count }) => [id, time, action, count]));
    if (pages.has(signature)) throw new HoyoRequestError("response", "官方星铁开拓力流水返回了重复页。");
    pages.add(signature);
    for (const row of rows) {
      if (row.action !== "随时间回复开拓力" || row.count <= 0) continue;
      if (!displayText(row.time, 40)) throw new HoyoRequestError("response", "官方星铁开拓力流水的恢复时间无效。");
      recoveries.push({ time: row.time, count: row.count });
    }
    if (page < maxPages && intervalMs) await wait(intervalMs, undefined, { signal });
  }
  return { recoveries, complete: false };
}
