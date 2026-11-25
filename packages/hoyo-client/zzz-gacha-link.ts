import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import { setTimeout as wait } from "node:timers/promises";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { zzzTuningPools } from "./zzz-tuning.ts";

const api = {
  nap_cn: "https://public-operation-common.mihoyo.com",
  nap_global: "https://public-operation-common-sg.hoyoverse.com",
} as const;
const path = "/common/gacha_record/api/getGachaLog";
const overseasRegions = { "10": "prod_gf_us", "13": "prod_gf_jp", "15": "prod_gf_eu", "17": "prod_gf_sg" } as const;
const pageSize = 20;
const maxResponseBytes = 256 * 1024;
const bands = [
  { type: "GACHA_TYPE_WEAPON_UP", gachaType: "3", requestType: "3001" },
  { type: "GACHA_TYPE_WEAPON_RETURN", gachaType: "103", requestType: "13001" },
  { type: "GACHA_TYPE_CHARACTER_UP", gachaType: "2", requestType: "2001" },
  { type: "GACHA_TYPE_CHARACTER_RETURN", gachaType: "102", requestType: "12001" },
  { type: "GACHA_TYPE_PERMANENT", gachaType: "1", requestType: "1001" },
  { type: "GACHA_TYPE_BANGBOO", gachaType: "5", requestType: "5001" },
] as const satisfies readonly { type: keyof typeof zzzTuningPools; gachaType: string; requestType: string }[];

type Band = typeof bands[number];
type Region = "prod_gf_cn" | "prod_qd_cn" | typeof overseasRegions[keyof typeof overseasRegions];
type GameBiz = keyof typeof api;

export interface ZzzGachaLinkRole {
  readonly uid: string;
  readonly region?: string;
  readonly gameBiz?: string;
}

export interface ZzzGachaLink {
  readonly uid: string;
  readonly region: Region;
  readonly gameBiz: GameBiz;
}

export interface ZzzGachaLinkDraw {
  readonly id: string;
  readonly itemId: string;
  readonly gachaId: string;
  readonly count: number;
  readonly time: string;
  readonly name: string;
  readonly lang: string;
  readonly itemType: "代理人" | "音擎" | "邦布";
  readonly rank: "2" | "3" | "4";
}

export interface ZzzGachaLinkSnapshot extends ZzzGachaLink {
  readonly timezone: number;
  readonly pools: readonly {
    readonly type: Band["type"];
    readonly name: typeof zzzTuningPools[Band["type"]]["name"];
    readonly gachaType: Band["gachaType"];
    readonly records: readonly ZzzGachaLinkDraw[];
  }[];
}

export interface ZzzGachaLinkOptions {
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
  readonly maxPages?: number;
  /** Milliseconds since the Unix epoch. */
  readonly now?: () => number;
}

export class ZzzGachaLinkError extends HoyoRequestError {
  constructor(readonly reason: "expired" | "rate-limited" | "risk" | "empty-unverified", code: HoyoRequestError["code"],
    message: string, status?: number, retcode?: number) {
    super(code, message, status, retcode);
  }
}

// Keep the secret outside the parsed handle so snapshots, logs and object serialization cannot expose it.
const credentials = new WeakMap<ZzzGachaLink, string>();

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimal(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d{0,18}$/u.test(value)) return value;
}

function whole(value: unknown): number | undefined {
  if (typeof value === "string" && /^-?\d{1,10}$/u.test(value)) value = Number(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
}

function badLink(message = $t("zzz-gacha-link.text_49d3b89275")): never {
  throw new HoyoRequestError("invalid-input", message);
}

function badResponse(message: string): never {
  throw new HoyoRequestError("response", message);
}

export function resolveZzzGachaLinkRole({ uid, region: selectedRegion, gameBiz: selectedBiz }: ZzzGachaLinkRole): ZzzGachaLink {
  if (typeof uid !== "string") badLink($t("zzz-gacha-link.text_a1486ef0dc"));
  const overseas = /^[1-9]\d{9}$/u.test(uid) ? overseasRegions[uid.slice(0, 2) as keyof typeof overseasRegions] : undefined;
  const cn = /^[1-9]\d{7,8}$/u.test(uid);
  const region = selectedRegion?.trim() || overseas || (cn ? "prod_gf_cn" : undefined);
  const gameBiz = overseas ? "nap_global" : "nap_cn";
  if (selectedBiz && selectedBiz !== gameBiz ||
      (overseas ? region !== overseas : !cn || (region !== "prod_gf_cn" && region !== "prod_qd_cn"))) {
    badLink($t("zzz-gacha-link.text_a1486ef0dc"));
  }
  return Object.freeze({ uid, region: region as Region, gameBiz });
}

export function isZzzGachaLinkMessage(value: string): boolean {
  if (!/^https?:\/\/[^/?#\s]+\/common\/gacha_record\/api\/getGachaLog(?:[/?#]|$)/iu.test(value.trim())) return false;
  const url = URL.parse(value.trim());
  return !!url && (url.hostname === "public-operation-common.mihoyo.com" ||
    url.hostname === "public-operation-common-sg.hoyoverse.com" ||
    url.searchParams.getAll("game_biz").some((game) => game === "nap_cn" || game === "nap_global"));
}

export function parseZzzGachaLink(input: string, role: ZzzGachaLinkRole): ZzzGachaLink {
  const expected = resolveZzzGachaLinkRole(role);
  if (typeof input !== "string" || input.length > 8192) badLink();
  const value = input.trim();
  const origin = api[expected.gameBiz];
  if (!value.startsWith(`${origin}${path}?`) || /[\x00-\x20\x7F]/u.test(value)) badLink();
  let url: URL;
  try { url = new URL(value); } catch { badLink(); }
  if (url.origin !== origin || url.pathname !== path || url.hash || url.username || url.password) badLink();
  function query(name: string): string | undefined {
    const found = url.searchParams.getAll(name);
    if (found.length > 1) badLink();
    return found[0];
  }
  if (query("game_biz") !== expected.gameBiz || query("region") !== expected.region) badLink($t("zzz-gacha-link.text_119cb23596"));
  for (const name of ["uid", "game_uid"]) {
    const uid = query(name);
    if (uid !== undefined && uid !== expected.uid) badLink($t("zzz-gacha-link.text_3dc5855f82"));
  }
  for (const [name, fixed] of [["authkey_ver", "1"], ["sign_type", "2"], ["auth_appid", "webview_gacha"]] as const) {
    const supplied = query(name);
    if (supplied !== undefined && supplied !== fixed) badLink();
  }
  const key = query("authkey");
  if (!key || !/^[\x21-\x7E]{1,4096}$/u.test(key)) badLink();
  credentials.set(expected, key);
  return expected;
}

function requestUrl(link: ZzzGachaLink, key: string, band: Band, page: number, cursor: string, timestamp: number) {
  const url = new URL(path, api[link.gameBiz]);
  url.search = new URLSearchParams({
    authkey_ver: "1", sign_type: "2", auth_appid: "webview_gacha", authkey: key, region: link.region, game_biz: link.gameBiz,
    init_log_gacha_type: band.requestType, init_log_gacha_base_type: band.gachaType,
    gacha_id: "2c1f5692fdfbb733a08733f9eb69d32aed1d37", timestamp: String(timestamp), lang: "zh-cn", device_type: "mobile",
    plat_type: "ios", gacha_type: band.requestType, real_gacha_type: band.gachaType, page: String(page),
    size: String(pageSize), end_id: cursor,
  }).toString();
  return url;
}

function draw(value: unknown, uid: string, band: Band, key: string, encodedKey: string): ZzzGachaLinkDraw {
  if (!object(value) || decimal(value.uid) !== uid) badResponse($t("zzz-gacha-link.text_7053782a77"));
  const id = decimal(value.id);
  const itemId = decimal(value.item_id);
  const gachaId = decimal(value.gacha_id);
  const count = whole(value.count);
  const raw = decimal(value.gacha_type);
  const declared = decimal(value.real_gacha_type);
  const rank = decimal(value.rank_type);
  const { item_type: itemType, name, lang, time } = value;
  const taggedReturn = declared === band.gachaType && ((band.gachaType === "102" && raw === "2") ||
    (band.gachaType === "103" && raw === "3"));
  if ((raw !== band.gachaType && raw !== band.requestType && !taggedReturn) ||
      (value.real_gacha_type !== undefined && declared !== band.gachaType && declared !== band.requestType)) {
    badResponse($t("zzz-gacha-link.text_d2bde6ff8a"));
  }
  if (!id || !itemId || !gachaId || count === undefined || count <= 0 || (rank !== "2" && rank !== "3" && rank !== "4") ||
      (itemType !== "代理人" && itemType !== "音擎" && itemType !== "邦布") || lang !== "zh-cn" || typeof name !== "string" ||
      !name.trim() || !name.isWellFormed() || Buffer.byteLength(name) > 512 || /[\x00-\x1F\x7F]|https?:\/\//iu.test(name) ||
      name.includes(key) || name.includes(encodedKey)) badResponse($t("zzz-gacha-link.text_2d34ffbc28"));
  if (typeof time !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(time)) badResponse($t("zzz-gacha-link.text_9ed7924fb6"));
  const instant = Date.parse(`${time.replace(" ", "T")}Z`);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 19).replace("T", " ") !== time) {
    badResponse($t("zzz-gacha-link.text_9ed7924fb6"));
  }
  return { id, itemId, gachaId, count, time, name, lang, itemType, rank };
}

async function readPage(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("Content-Length")) > maxResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    badResponse($t("zzz-gacha-link.text_e9792f7548"));
  }
  if (!response.body) badResponse($t("zzz-gacha-link.text_edf8261a16"));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) badResponse($t("zzz-gacha-link.text_e9792f7548"));
      chunks.push(value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
  } catch (error) {
    if (signal.aborted) throw new HoyoRequestError("transport", $t("zzz-gacha-link.text_2ad3db443e"));
    if (error instanceof HoyoRequestError) throw error;
    badResponse($t("zzz-gacha-link.text_0fde82ace9"));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function apiFailure(retcode: number, status: number): never {
  if (retcode === -100) throw new ZzzGachaLinkError("expired", "api", $t("zzz-gacha-link.text_26a1089ff8"), status, retcode);
  if (retcode === -110) throw new ZzzGachaLinkError("rate-limited", "api", $t("zzz-gacha-link.text_622350c4b3"), status, retcode);
  if (retcode === 1034 || retcode === 10035 || retcode === 10041) {
    throw new ZzzGachaLinkError("risk", "api", $t("zzz-gacha-link.text_a3e3173849"), status, retcode);
  }
  throw new HoyoRequestError("api", $t("zzz-gacha-link.text_f3d71c689a"), status, retcode);
}

export async function readZzzGachaLink(link: ZzzGachaLink, transport: HoyoTransport,
  { signal, intervalMs = 1_200, maxPages = 50, now = Date.now }: ZzzGachaLinkOptions = {},
  verifyProfile?: () => Promise<void>): Promise<ZzzGachaLinkSnapshot> {
  const key = credentials.get(link);
  if (!key) badLink();
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 500) badLink($t("zzz-gacha-link.text_c560bbef16"));

  let requested = false;
  let timezone: number | undefined;
  let verifiedUid = false;
  const seenIds = new Set<string>();
  const encodedKey = encodeURIComponent(key);
  const pools: ZzzGachaLinkSnapshot["pools"][number][] = [];

  async function guard() {
    if (signal?.aborted) throw new HoyoRequestError("transport", $t("zzz-gacha-link.text_7680614ff1"));
    await verifyProfile?.();
    if (signal?.aborted) throw new HoyoRequestError("transport", $t("zzz-gacha-link.text_7680614ff1"));
  }

  async function request(band: Band, page: number, cursor: string, secret: string) {
    if (requested && intervalMs) {
      try { await wait(intervalMs, undefined, { signal }); }
      catch { throw new HoyoRequestError("transport", $t("zzz-gacha-link.text_7680614ff1")); }
    }
    await guard();
    requested = true;
    const timestamp = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) badLink($t("zzz-gacha-link.text_1b0d64e47b"));
    const timeout = AbortSignal.timeout(20_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await transport(requestUrl(link, secret, band, page, cursor, timestamp), {
        method: "GET", headers: { Accept: "application/json", "Content-Type": "application/json" },
        redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: requestSignal,
      });
    } catch {
      throw new HoyoRequestError("transport", $t("zzz-gacha-link.text_9b59addfa4"));
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      await guard();
      if (response.status === 429) throw new ZzzGachaLinkError("rate-limited", "http", $t("zzz-gacha-link.text_622350c4b3"), 429);
      if (response.status === 401) throw new ZzzGachaLinkError("expired", "http", $t("zzz-gacha-link.text_26a1089ff8"), 401);
      throw new HoyoRequestError("http", $t("zzz-gacha-link.text_15906085d6"), response.status);
    }
    const payload = await readPage(response, requestSignal);
    await guard();
    const retcode = object(payload) ? whole(payload.retcode) : undefined;
    if (!object(payload) || retcode === undefined) badResponse($t("zzz-gacha-link.text_93e99fcfcb"));
    if (retcode !== 0) apiFailure(retcode, response.status);
    if (!object(payload.data)) badResponse($t("zzz-gacha-link.text_a315d9b0b0"));
    return payload.data;
  }

  for (const band of bands) {
    const records: ZzzGachaLinkDraw[] = [];
    let finished = false;
    let cursor = "0";
    for (let page = 1; page <= maxPages; page++) {
      const data = await request(band, page, cursor, key);
      const offset = whole(data.region_time_zone);
      if (data.region !== link.region || offset === undefined || offset < -12 || offset > 14 ||
          (timezone !== undefined && offset !== timezone) || (data.uid !== undefined && decimal(data.uid) !== link.uid)) {
        badResponse($t("zzz-gacha-link.text_f01ebbbcef"));
      }
      timezone = offset;
      verifiedUid ||= data.uid !== undefined;
      const size = data.size === undefined ? pageSize : whole(data.size);
      if (!Array.isArray(data.list) || size === undefined || size < data.list.length || size > pageSize) {
        badResponse($t("zzz-gacha-link.text_9d46c12f89"));
      }
      if (!data.list.length) { finished = true; break; }
      for (const row of data.list) {
        const current = draw(row, link.uid, band, key, encodedKey);
        if (seenIds.has(current.id) || (cursor !== "0" && BigInt(current.id) >= BigInt(cursor))) {
          badResponse($t("zzz-gacha-link.text_d0a58e1e9b"));
        }
        seenIds.add(current.id);
        records.push(current);
        cursor = current.id;
      }
      verifiedUid = true;
    }
    if (!finished) badResponse($t("zzz-gacha-link.text_3d477d7397"));
    pools.push({ type: band.type, gachaType: band.gachaType, name: zzzTuningPools[band.type].name, records });
  }
  await guard();
  if (!verifiedUid || timezone === undefined) {
    throw new ZzzGachaLinkError("empty-unverified", "response", $t("zzz-gacha-link.text_57ef76b88a"));
  }
  return { ...link, timezone, pools };
}
