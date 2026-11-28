import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import { setTimeout as wait } from "node:timers/promises";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { gachaAuthHeaders, gachaStokenCookie } from "./gacha-auth-request.ts";
import { readHoYoLabAuthKey } from "./hoyolab-authkey.ts";

export const genshinGachaPools = [
  { type: 301, name: $t("genshin-gacha.text_c47b54e84e") }, { type: 302, name: $t("genshin-gacha.text_4fe131173e") }, { type: 500, name: $t("genshin-gacha.text_8f161c1237") }, { type: 200, name: $t("genshin-gacha.text_300b6634fe") },
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
const gameBiz = "hk4e_cn";
const authApp = "webview_gacha";

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
    throw new HoyoRequestError("invalid-input", $t("genshin-gacha.text_a1797bcbe4"));
  }
  return region;
}

function parseRow(row: unknown, uid: string, type: GenshinGachaPool): GenshinGachaRow {
  if (!record(row)) throw new HoyoRequestError("response", $t("genshin-gacha.text_203e0e6c84"));
  const id = decimal(row.id);
  const gachaType = typeof row.gacha_type === "string" || typeof row.gacha_type === "number" ? String(row.gacha_type) : "";
  if (!id || (typeof row.uid !== "string" && typeof row.uid !== "number") || String(row.uid) !== uid ||
      (gachaType !== String(type) && !(type === 301 && gachaType === "400"))) {
    throw new HoyoRequestError("response", $t("genshin-gacha.text_ce1ee3106c"));
  }
  return { ...row, id, uid, gacha_type: gachaType as RecordPool };
}

export class GenshinAuthKeyRequestError extends HoyoRequestError {}

function createGenshinRequests(
  transport: HoyoTransport,
  signal?: AbortSignal,
  verifyProfile?: () => Promise<void>,
) {
  async function guard() {
    if (signal?.aborted) throw new HoyoRequestError("transport", $t("genshin-gacha.text_43424ca534"));
    await verifyProfile?.();
    if (signal?.aborted) throw new HoyoRequestError("transport", $t("genshin-gacha.text_43424ca534"));
  }

  async function request(endpoint: URL, auth: boolean, init: RequestInit) {
    await guard();
    const timeout = AbortSignal.timeout(auth ? 20_000 : 30_000);
    let response: Response;
    try {
      response = await transport(endpoint, { ...init, redirect: "error", credentials: "omit",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch {
      throw new HoyoRequestError("transport", $t("genshin-gacha.text_7fc7e6e79c"));
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HoyoRequestError("http", $t("genshin-gacha.text_f4f1c8af84"), response.status);
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const code = record(payload) ? payload.retcode : undefined;
    const retcode = auth && typeof code === "string" && /^-?\d{1,10}$/u.test(code) ? Number(code) : code;
    if (typeof retcode !== "number" || !Number.isSafeInteger(retcode) || !record(payload)) {
      throw new HoyoRequestError("response", $t("genshin-gacha.text_12af51d8d7"));
    }
    if (retcode !== 0) {
      const ServiceError = auth ? GenshinAuthKeyRequestError : HoyoRequestError;
      throw new ServiceError("api", $t("genshin-gacha.text_e810ccba12"), response.status, retcode);
    }
    if (!record(payload.data)) throw new HoyoRequestError("response", $t("genshin-gacha.text_60a2671fe4"));
    return payload.data;
  }
  return { guard, request };
}

export async function readGenshinAuthKey(
  source: ProfileRequestContext,
  transport: HoyoTransport,
  { signal }: Pick<GenshinGachaOptions, "signal"> = {},
  verifyProfile?: () => Promise<void>,
) {
  if (source.international) {
    if (source.game !== "gs") throw new HoyoRequestError("invalid-input", $t("genshin-gacha.text_a1797bcbe4"));
    const { uid, region, gameBiz, authkey } = await readHoYoLabAuthKey(source, transport, { signal }, verifyProfile);
    const url = new URL("https://public-operation-hk4e-sg.hoyoverse.com/gacha_info/api/getGachaLog");
    url.search = new URLSearchParams({ authkey_ver: "1", sign_type: "2", auth_appid: authApp, authkey,
      region, game_biz: gameBiz, lang: "zh-cn", gacha_type: "301", page: "1", size: "20", end_id: "0" }).toString();
    return { uid, region, url };
  }
  const region = cnRegion(source);
  const uid = source.role.uid;
  const cookie = gachaStokenCookie(source, $t("genshin-gacha.text_d1597c51ed"));
  const { request } = createGenshinRequests(transport, signal, verifyProfile);
  let headers: Headers;
  try { headers = gachaAuthHeaders(cookie, source); }
  catch { throw new HoyoRequestError("invalid-input", $t("genshin-gacha.text_12da1eff35")); }
  const credential = await request(new URL("/binding/api/genAuthKey", authOrigin), true, {
    method: "POST", headers,
    body: JSON.stringify({ auth_appid: authApp, game_biz: gameBiz, game_uid: Number(uid), region }),
  });
  const authkey = credential.authkey;
  if (typeof authkey !== "string" || !authkey || authkey.length > 4096 || /[\u0000-\u0020\u007f]/u.test(authkey) ||
      (credential.game_uid !== undefined && decimal(credential.game_uid) !== uid) ||
      (credential.region !== undefined && credential.region !== region) ||
      (credential.game_biz !== undefined && credential.game_biz !== gameBiz)) {
    throw new HoyoRequestError("response", $t("genshin-gacha.text_2d9e085462"));
  }

  const url = new URL("/gacha_info/api/getGachaLog", gachaOrigin);
  url.search = new URLSearchParams({ authkey_ver: "1", sign_type: "2", auth_appid: authApp, init_type: "301",
    gacha_id: "fecafa7b6560db5f3182222395d88aaa6aaac1bc", timestamp: String(Math.floor(Date.now() / 1000)),
    lang: "zh-cn", device_type: "mobile", plat_type: "ios", region, authkey, game_biz: gameBiz,
    gacha_type: "301", page: "1", size: "5", end_id: "0" }).toString();
  return { uid, region, url };
}

async function readGenshinGachaOnce(
  source: ProfileRequestContext,
  transport: HoyoTransport,
  { signal, intervalMs = 1_000, maxPages = 1_000 }: GenshinGachaOptions = {},
  verifyProfile?: () => Promise<void>,
) {
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647 ||
      !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
    throw new HoyoRequestError("invalid-input", $t("genshin-gacha.text_46945a7aad"));
  }
  const { uid, region, url } = await readGenshinAuthKey(source, transport, { signal }, verifyProfile);
  const { guard, request } = createGenshinRequests(transport, signal, verifyProfile);
  url.searchParams.set("size", "20");
  async function readPool(type: GenshinGachaPool) {
    const rows: GenshinGachaRow[] = [];
    let cursor = "0";
    for (let page = 1; page <= maxPages; page++) {
      if (intervalMs) {
        try { await wait(intervalMs, undefined, { signal }); }
        catch { throw new HoyoRequestError("transport", $t("genshin-gacha.text_43424ca534")); }
      }
      const endpoint = new URL(url);
      endpoint.searchParams.set("gacha_type", String(type));
      endpoint.searchParams.set("page", String(page));
      endpoint.searchParams.set("end_id", cursor);
      const data = await request(endpoint, false, { method: "GET", headers: { Accept: "application/json" } });
      if ((data.region !== undefined && data.region !== region) || (data.uid !== undefined && decimal(data.uid) !== uid)) {
        throw new HoyoRequestError("response", $t("genshin-gacha.text_0875a96f0e"));
      }
      if (!Array.isArray(data.list) || data.list.length > 20) {
        throw new HoyoRequestError("response", $t("genshin-gacha.text_afa5d7703c"));
      }
      if (!data.list.length) return rows;
      const batch = data.list.map((row) => parseRow(row, uid, type));
      const next = batch[batch.length - 1]!.id;
      if (cursor !== "0" && BigInt(next) >= BigInt(cursor)) {
        throw new HoyoRequestError("response", $t("genshin-gacha.text_e42ce73091"));
      }
      rows.push(...batch);
      cursor = next;
    }
    throw new HoyoRequestError("response", $t("genshin-gacha.text_89d0456c9a"));
  }

  const pools: { type: GenshinGachaPool; name: string; records: GenshinGachaRow[] }[] = [];
  for (const pool of genshinGachaPools) pools.push({ ...pool, records: await readPool(pool.type) });
  await guard();
  return { uid, region, pools };
}


export async function readGenshinGacha(
  source: ProfileRequestContext,
  transport: HoyoTransport,
  options: GenshinGachaOptions = {},
  verifyProfile?: () => Promise<void>,
) {
  try {
    return await readGenshinGachaOnce(source, transport, options, verifyProfile);
  } catch (error) {
    if (options.signal?.aborted || !(error instanceof HoyoRequestError) || error instanceof GenshinAuthKeyRequestError ||
        error.code !== "api" || error.retcode !== -101) throw error;
    return readGenshinGachaOnce(source, transport, options, verifyProfile);
  }
}
