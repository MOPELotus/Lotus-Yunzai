import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import { setTimeout as wait } from "node:timers/promises";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";
import { gachaAuthHeaders, starRailLedgerStokenCookie } from "./gacha-auth-request.ts";

const types = { dreams: "Dreams", stellar: "Stellar", power: "Power", relic: "Relic", cone: "Cone" } as const;
const origin = "https://api-takumi.mihoyo.com";
const ledgerOrigin = "https://public-operation-hkrpg.mihoyo.com";
const maxLedgerPages = 120;
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
    throw new HoyoRequestError("invalid-input", $t("starrail-ledger.text_a0c40c636e"));
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
    throw new HoyoRequestError("invalid-input", $t("starrail-ledger.text_6347e09a79"));
  }

  async function guard() {
    signal?.throwIfAborted();
    await verifyProfile?.();
    signal?.throwIfAborted();
  }

  async function request(url: URL, init: RequestInit, authorizing: boolean) {
    const action = authorizing ? $t("starrail-ledger.text_c1db1d44aa") : $t("starrail-ledger.text_f2e78d1be7");
    await guard();
    const timeout = AbortSignal.timeout(15_000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await transport(url, { ...init, redirect: "error", credentials: "omit", signal: deadline });
    } catch {
      await guard();
      throw new HoyoRequestError("transport", $t("starrail-ledger.text_4464b90e26", { "action": action }));
    }
    const verification = response.headers.get("x-rpc-aigis")?.trim();
    if (response.redirected || (response.url && response.url !== url.href) ||
        (!response.ok && response.status !== 401) || (verification && verification !== "{}")) {
      await response.body?.cancel().catch(() => undefined);
      await guard();
      const message = response.status === 429 ? $t("starrail-ledger.text_7a164fbe8a", { "action": action }) :
        verification && verification !== "{}" ? $t("starrail-ledger.text_81cb6e5539", { "action": action }) :
          $t("starrail-ledger.text_d51a86f9d0", { "action": action });
      throw new HoyoRequestError("http", message, response.status);
    }
    const payload = await readGameRecordPayload(response, authorizing ? 32 * 1024 : 64 * 1024, deadline);
    await guard();
    if (timeout.aborted) throw new HoyoRequestError("transport", $t("starrail-ledger.text_d668038810", { "action": action }));
    const code = integer(payload?.retcode);
    if (code !== undefined && risk.has(code)) {
      throw new HoyoRequestError("api", $t("starrail-ledger.text_81cb6e5539", { "action": action }), response.status, code);
    }
    if (response.status === 401 || (code !== undefined && expired.has(code))) {
      throw new HoyoRequestError("api", authorizing ? $t("starrail-ledger.text_88023acf7c") :
        $t("starrail-ledger.text_5183bb09c9"), response.status, code);
    }
    if (code === undefined) throw new HoyoRequestError("response", $t("starrail-ledger.text_2a6a4c6138", { "action": action }));
    if (code !== 0) throw new HoyoRequestError("api", $t("starrail-ledger.text_920750a297", { "action": action }), response.status, code);
    const data = object(payload?.data);
    if (!data || (Object.hasOwn(data, "role") && !object(data.role)) ||
        !matchingRole(data, uid, region) || !matchingRole(object(data.role) ?? {}, uid, region)) {
      throw new HoyoRequestError("response", $t("starrail-ledger.text_c480639c27", { "action": action }));
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
    throw new HoyoRequestError("response", $t("starrail-ledger.text_945311f4c5"));
  }

  return async function readPage(kind: StarRailLedgerKind, cursor: string, size: number) {
    const url = new URL(`/common/hkrpg_self_help_inquiry/${types[kind]}/GetList`, ledgerOrigin);
    url.search = new URLSearchParams({ sign_type: "2", auth_appid: authAppid, authkey_ver: "1", win_direction: "portrait",
      page_id: "4", bbs_auth_required: "true", bbs_game_role_required: gameBiz, app_client: "bbs", game_biz: gameBiz,
      lang: "zh-cn", authkey, end_id: cursor, size: String(size) }).toString();
    const data = await request(url, { method: "GET" }, false);
    if (!Array.isArray(data.list) || data.list.length > size) {
      throw new HoyoRequestError("response", $t("starrail-ledger.text_b08c5f8c24"));
    }
    let previous = cursor ? BigInt(cursor) : undefined;
    return data.list.map(entry => {
      const row = object(entry);
      const count = integer(row?.add_num);
      const id = typeof row?.id === "string" ? row.id :
        typeof row?.id === "number" && Number.isSafeInteger(row.id) ? String(row.id) : "";
      if (!row || count === undefined || !displayText(row.time, 40) || !displayText(row.action, 120) ||
          !matchingRole(row, uid, region) ||
          !/^[1-9]\d{0,39}$/u.test(id)) {
        throw new HoyoRequestError("response", $t("starrail-ledger.text_26d24530b5"));
      }
      const current = BigInt(id);
      if (previous !== undefined && current >= previous) {
        throw new HoyoRequestError("response", $t("starrail-ledger.text_6c958cb9ea"));
      }
      previous = current;
      return { count, time: row.time, action: row.action, id };
    });
  };
}

export async function readStarRailLedger(source: ProfileRequestContext, transport: HoyoTransport,
  { kind, page, signal }: StarRailLedgerOptions, verifyProfile?: () => Promise<void>) {
  if (!Object.hasOwn(types, kind) || !Number.isSafeInteger(page) || page < 1 || page > maxLedgerPages) {
    throw new HoyoRequestError("invalid-input", $t("starrail-ledger.text_6e235a3e27", { "maxLedgerPages": maxLedgerPages }));
  }
  const readPage = await openStarRailLedger(source, transport, signal, verifyProfile);
  let cursor = "";
  let selected: Awaited<ReturnType<typeof readPage>> = [];
  for (let current = 1; current <= page; current++) {
    const batch = await readPage(kind, cursor, pageSize);
    if (current === page) { selected = batch; break; }
    if (!batch.length) return { rows: [] };
    cursor = batch.at(-1)!.id;
  }
  const rows: StarRailLedgerRow[] = [];
  for (const row of selected) {
    if (row.count <= (kind === "power" ? 1 : 0)) continue;
    if (!displayText(row.time, 40) || !displayText(row.action, 120)) {
      throw new HoyoRequestError("response", $t("starrail-ledger.text_43c9eaa282"));
    }
    rows.push({ count: row.count, time: row.time, reason: row.action });
  }
  return { rows };
}


export async function readStarRailOnline(source: ProfileRequestContext, transport: HoyoTransport,
  { signal, maxPages = 120, intervalMs = 500 }: StarRailOnlineOptions, verifyProfile?: () => Promise<void>) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 240 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 5_000) {
    throw new HoyoRequestError("invalid-input", $t("starrail-ledger.text_e31092f63d"));
  }
  const readPage = await openStarRailLedger(source, transport, signal, verifyProfile);
  const recoveries: StarRailPowerRecovery[] = [];
  let cursor = "";
  for (let page = 1; page <= maxPages; page++) {
    const rows = await readPage("power", cursor, 50);
    if (!rows.length) return { recoveries, complete: true };
    for (const row of rows) {
      if (row.action !== "随时间回复开拓力" || row.count <= 0) continue;
      if (!displayText(row.time, 40)) throw new HoyoRequestError("response", $t("starrail-ledger.text_082511f5c8"));
      recoveries.push({ time: row.time, count: row.count });
    }
    cursor = rows.at(-1)!.id;
    if (page < maxPages && intervalMs) await wait(intervalMs, undefined, { signal });
  }
  return { recoveries, complete: false };
}
