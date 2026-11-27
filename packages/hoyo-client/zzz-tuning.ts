import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import { setTimeout as wait } from "node:timers/promises";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";

const apiRoot = "https://act-api-takumi.mihoyo.com/event/nap_gacha_record/api/zzz/";
const origin = "https://act.mihoyo.com";
const referer = `${origin}/zzz/event/gacha-record/index.html`;
const batchSize = 8;
const rateLimitBackoff = [15_000, 30_000] as const;
const rateLimitWaitBudget = 60_000;
type TuningQueue = { tail: Promise<void>; last: number; cooldown: number };
const tuningQueues = new WeakMap<HoyoTransport, TuningQueue>();

function tuningQueue(transport: HoyoTransport): TuningQueue {
  let queue = tuningQueues.get(transport);
  if (!queue) {
    queue = { tail: Promise.resolve(), last: -Infinity, cooldown: 0 };
    tuningQueues.set(transport, queue);
  }
  return queue;
}

export const zzzTuningPools = {
  GACHA_TYPE_WEAPON_UP: { id: 3, name: $t("zzz-tuning.text_3ea1ef49dc") },
  GACHA_TYPE_WEAPON_RETURN: { id: 103, name: $t("zzz-tuning.text_3e77093711") },
  GACHA_TYPE_CHARACTER_UP: { id: 2, name: $t("zzz-tuning.text_9ca71e998a") },
  GACHA_TYPE_CHARACTER_RETURN: { id: 102, name: $t("zzz-tuning.text_f6dbc05fda") },
  GACHA_TYPE_PERMANENT: { id: 1, name: $t("zzz-tuning.text_e0b2744a47") },
  GACHA_TYPE_BANGBOO: { id: 5, name: $t("zzz-tuning.text_c9f8671eae") },
} as const;

const tickets = {
  GACHA_TICKET_TYPE_POLYCHROME: "polychrome",
  GACHA_TICKET_TYPE_RECHARGE_MONOCHROME: "monochrome",
  GACHA_TICKET_TYPE_ENCRYPTED_MASTER_TAPE: "encryptedMasterTape",
  GACHA_TICKET_TYPE_MASTER_TAPE: "masterTape",
  GACHA_TICKET_TYPE_BOOPON: "boopon",
} as const;

type Json = Record<string, unknown>;
type Pool = keyof typeof zzzTuningPools;
type Ticket = typeof tickets[keyof typeof tickets];
type Guard = () => Promise<void>;
type Endpoint = "index" | "cur_pool_stat" | "hist_pool_stat";

export interface ZzzTuningOptions {
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
}

export type ZzzTuningInventory = Partial<Record<Ticket, number>>;

export interface ZzzTuningRecord {
  readonly itemId: string;
  readonly name: string;
  readonly icon: string;
  readonly rarity: string;
  readonly itemType: string;
  readonly isUp: boolean;
  readonly upTag: string;
  readonly count: number | null;
  readonly time: number | null;
  readonly sort: string;
  readonly version: string;
}

export interface ZzzTuningPeriod {
  readonly version: string;
  readonly status: string;
  readonly startAt: number | null;
  readonly endAt: number | null;
  readonly leftStartAt: number | null;
  readonly leftEndAt: number | null;
  readonly firstUp: ZzzTuningRecord | null;
  readonly records: readonly ZzzTuningRecord[];
  readonly items: readonly ZzzTuningRecord[];
}

export interface ZzzTuningPool {
  readonly type: Pool;
  readonly name: typeof zzzTuningPools[Pool]["name"];
  readonly totalDraws: number;
  readonly totalS: number;
  readonly upCount: number | null;
  readonly averageUp: number | null;
  readonly pity: number | null;
  readonly guaranteedWithin: number | null;
  readonly records: readonly ZzzTuningRecord[];
  readonly periods: readonly ZzzTuningPeriod[];
}

export interface ZzzTuningSnapshot {
  readonly version: 1;
  readonly uid: string;
  readonly region: "prod_gf_cn" | "prod_qd_cn";
  readonly profileId: number;
  readonly currentVersion: string;
  readonly totalDraws: number;
  readonly totalS: number;
  readonly inventory: ZzzTuningInventory;
  readonly pools: readonly ZzzTuningPool[];
  readonly updatedAt: string;
}

export class ZzzTuningRateLimitError extends HoyoRequestError {
  constructor(status: number, retcode?: number, readonly retryAfterMs?: number) {
    super(status === 429 ? "http" : "api", $t("zzz-tuning.text_1fdfaa413c"), status, retcode);
  }
}

const expiredCodes = new Set([-100, 10001, 10101, 10102, 10103]);
const captchaOrRisk = new Set([1034, 10035, 10041]);

class CookieExpired extends HoyoRequestError {}

export function isZzzTuningCookieExpired(error: unknown): boolean {
  return error instanceof HoyoRequestError && !(error instanceof ZzzTuningRateLimitError) &&
    (error instanceof CookieExpired || (error.code === "http" && error.status === 401));
}

function invalid(message: string): never {
  throw new HoyoRequestError("response", message);
}

function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
}

function decimal(value: unknown): number | null {
  const n = typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

function uint(value: unknown): number | null {
  const n = decimal(value);
  return n !== null && Number.isSafeInteger(n) ? n : null;
}

function versionOf(value: unknown): string {
  const version = text(value);
  if (!version || /[,\r\n\0]/u.test(version)) invalid($t("zzz-tuning.text_f20ecb2204"));
  return version;
}

function list(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(message);
  return value;
}

function recordOf(row: Json, version: string): ZzzTuningRecord {
  return {
    itemId: text(row.item_id), name: text(row.name), icon: text(row.icon), rarity: text(row.rarity),
    itemType: text(row.item_type), isUp: row.is_up === true || row.is_up === 1 || row.is_up === "1" || row.is_up === "true",
    upTag: text(row.up_tag), count: uint(row.count), time: uint(row.record_time), sort: text(row.sort), version,
  };
}

function recordList(value: unknown, version: string): ZzzTuningRecord[] {
  return list(value ?? [], $t("zzz-tuning.text_ccdd412151")).flatMap((entry) => {
    const row = object(entry);
    if (!row || row.item_id == null || !text(row.item_id)) invalid($t("zzz-tuning.text_dfea447d04"));
    return text(row.item_id) === "0" ? [] : [recordOf(row, version)];
  });
}

function periodsOf(data: Json): ZzzTuningPeriod[] {
  return list(data.list, $t("zzz-tuning.text_bc19b1116f")).map((entry) => {
    const row = object(entry);
    if (!row) invalid($t("zzz-tuning.text_a4013274c6"));
    const version = versionOf(row.version);
    const firstUp = object(row.first_up);
    return {
      version, status: text(row.gacha_state), startAt: uint(row.start_ts), endAt: uint(row.end_ts),
      leftStartAt: uint(row.left_start_ts), leftEndAt: uint(row.left_end_ts),
      firstUp: firstUp && text(firstUp.item_id) && text(firstUp.item_id) !== "0" ? recordOf(firstUp, version) : null,
      records: recordList(row.cur_records, version), items: recordList(row.cur_item_list, version),
    };
  });
}

function inventoryOf(index: Json): ZzzTuningInventory {
  const result: ZzzTuningInventory = {};
  for (const entry of list(index.cur_tickets ?? [], $t("zzz-tuning.text_7ba978f27e"))) {
    const row = object(entry);
    const type = text(row?.ticket_type);
    if (!Object.hasOwn(tickets, type)) continue;
    const amount = row?.ticket_cnt;
    if (amount == null || (typeof amount === "string" && !amount.trim())) continue;
    const count = uint(amount);
    const key = tickets[type as keyof typeof tickets];
    if (count === null || (result[key] !== undefined && result[key] !== count)) invalid($t("zzz-tuning.text_31a4180cb7"));
    result[key] = count;
  }
  return result;
}

function poolOf(type: Pool, band: Json, periods: ZzzTuningPeriod[]): ZzzTuningPool {
  const name = zzzTuningPools[type].name;
  const totalDraws = uint(band.total_count);
  const totalS = uint(band.s_count);
  const records = periods.flatMap((period) => period.records);
  const byKey = new Map<string, ZzzTuningRecord[]>();
  for (const period of periods) {
    const occurrences = new Map<string, number>();
    for (const item of period.records) {
      const key = JSON.stringify([item.itemId, item.time, item.sort, item.count]);
      const count = (occurrences.get(key) ?? 0) + 1;
      const group = byKey.get(key) ?? [];
      if (group.length < count) group.push(item);
      byKey.set(key, group);
      occurrences.set(key, count);
    }
  }

  // A record may appear in multiple periods. Keep genuine multiplicity if the official S total requires it.
  const unique = [...byKey.values()].flat();
  const checked = unique.length === totalS ? unique : records;
  if (totalDraws === null || totalS === null || totalDraws < totalS || checked.length !== totalS ||
      checked.some((row) => row.rarity !== "S" || !row.time || !row.count)) {
    invalid($t("zzz-tuning.text_44d1a27a4a", { "name": name }));
  }
  return {
    type, name, totalDraws, totalS, upCount: uint(band.up_count), averageUp: decimal(band.avr_up_count),
    pity: uint(band.next_s_cur_times), guaranteedWithin: uint(band.new_s_max_times), periods,
    records: checked.sort((a, b) => b.time! - a.time! || b.sort.localeCompare(a.sort, "en", { numeric: true })),
  };
}

export function resolveZzzTuningRegion(source: Pick<ProfileRequestContext, "game" | "role">): ZzzTuningSnapshot["region"] {
  const { uid, gameBiz } = source.role;
  const region = source.role.region.trim() || (/^[1-9]\d{7,8}$/u.test(uid) ? "prod_gf_cn" : "");
  if (source.game !== "zzz" || !/^[1-9]\d{7,9}$/u.test(uid) || (gameBiz && gameBiz !== "nap_cn") ||
      /^(?:10|13|15|17)\d{8}$/u.test(uid) || (region !== "prod_gf_cn" && region !== "prod_qd_cn")) {
    throw new HoyoRequestError("invalid-input", $t("zzz-tuning.text_127f09cf84"));
  }
  return region;
}

function retryAfter(response: Response, now: () => Date): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return;
  if (/^\d+$/u.test(value)) {
    const time = Number(value) * 1000;
    return Number.isSafeInteger(time) ? time : undefined;
  }
  const time = Date.parse(value);
  if (Number.isFinite(time) && new Date(time).toUTCString() === value) return Math.max(0, time - now().getTime());
}

function apiError(payload: Json, status: number, retcode: number): HoyoRequestError {
  const message = text(payload.message) || text(payload.msg) || text(object(payload.data)?.message);
  if (/visit too frequently|too frequent|rate limit|频繁/iu.test(message)) {
    return new ZzzTuningRateLimitError(status, retcode);
  }
  const blocked = captchaOrRisk.has(retcode) || /验证码|captcha|geetest|challenge|风控/iu.test(message);
  if (!blocked && (expiredCodes.has(retcode) ||
      /cookie.{0,16}(?:失效|过期|expired|invalid)|(?:expired|invalid).{0,16}cookie|请(?:先|重新)?登[录陆]|(?:未登[录陆]|please (?:log in|login)|登录(?:状态)?(?:失效|过期))/iu.test(message))) {
    return new CookieExpired("api", $t("zzz-tuning.text_5004d886da"), status, retcode);
  }
  return new HoyoRequestError("api", $t("zzz-tuning.text_c6435a050f"), status, retcode);
}

function tuningRequest(source: ProfileRequestContext, transport: HoyoTransport, options: ZzzTuningOptions, guard?: Guard) {
  const {
    intervalMs = 1200, signal, now = () => new Date(),
    sleep = (durationMs: number) => wait(durationMs, undefined, { signal }),
  } = options;
  const region = resolveZzzTuningRegion(source);
  const { uid } = source.role;
  const cookie = source.account.cookie;
  if (!cookie.trim() || !cookie.includes("=") || /[\r\n\0]/u.test(cookie) ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647) {
    throw new HoyoRequestError("invalid-input", $t("zzz-tuning.text_83123df61a"));
  }

  const canceled = () => new HoyoRequestError("transport", $t("zzz-tuning.text_9c705789b8"));
  function checkSignal() {
    if (signal?.aborted) throw canceled();
  }

  async function check() {
    checkSignal();
    await guard?.();
    checkSignal();
  }

  async function pause(durationMs: number) {
    try {
      await sleep(durationMs, signal);
    } catch {
      throw canceled();
    }
  }

  const queue = intervalMs ? tuningQueue(transport) : undefined;
  let retries = 0;
  let waited = 0;
  async function dispatch(endpoint: Endpoint, extra?: Record<string, string>) {
    checkSignal();
    if (!queue) return read(endpoint, extra);
    const job = queue.tail.then(async () => {
      checkSignal();
      const delay = Math.ceil(Math.max(queue.last + intervalMs, queue.cooldown) - performance.now());
      if (delay > rateLimitWaitBudget) throw new ZzzTuningRateLimitError(429, undefined, delay);
      if (delay > 0) await pause(delay);
      try {
        return await read(endpoint, extra);
      } catch (error) {
        if (error instanceof ZzzTuningRateLimitError) {
          const backoff = rateLimitBackoff[Math.min(retries, rateLimitBackoff.length - 1)]!;
          queue.cooldown = Math.max(queue.cooldown, performance.now() + Math.max(backoff, error.retryAfterMs ?? 0));
        }
        throw error;
      } finally {
        queue.last = performance.now();
      }
    });
    queue.tail = job.then(() => undefined, () => undefined);
    if (!signal) return job;
    const aborted = Promise.withResolvers<never>();
    const cancel = () => aborted.reject(canceled());
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await Promise.race([job, aborted.promise]);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  async function request(endpoint: Endpoint, extra?: Record<string, string>) {
    for (;;) {
      try {
        return await dispatch(endpoint, extra);
      } catch (error) {
        if (!(error instanceof ZzzTuningRateLimitError) || error.status !== 429 ||
            error.retryAfterMs === undefined) throw error;
        const backoff = rateLimitBackoff[retries];
        if (backoff === undefined) throw error;
        const delay = Math.max(backoff, error.retryAfterMs, intervalMs);
        if (!Number.isFinite(delay) || waited + delay > rateLimitWaitBudget) throw error;
        retries++;
        waited += delay;
        await pause(delay);
      }
    }
  }

  async function read(endpoint: Endpoint, extra?: Record<string, string>) {
    await check();
    const url = new URL(endpoint, apiRoot);
    url.search = new URLSearchParams({ uid, region, ...extra }).toString();
    const deadline = AbortSignal.timeout(15_000);
    let response: Response;
    try {
      response = await transport(url, {
        headers: { Accept: "application/json, text/plain, */*", Cookie: cookie, Origin: origin, Referer: referer },
        redirect: "error", signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch {
      await check();
      throw new HoyoRequestError("transport", $t("zzz-tuning.text_3d61b75b23"));
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      await check();
      if (response.status === 429) throw new ZzzTuningRateLimitError(429, undefined, retryAfter(response, now));
      throw new HoyoRequestError("http", $t("zzz-tuning.text_2ab769470e"), response.status);
    }
    const payload = object(await response.json().catch(() => undefined));
    await check();
    const rawCode = text(payload?.retcode);
    const retcode = Number(rawCode);
    if (!payload || !/^-?\d+$/u.test(rawCode) || !Number.isSafeInteger(retcode)) {
      invalid($t("zzz-tuning.text_00ca9fd8a4"));
    }
    if (retcode !== 0) throw apiError(payload, response.status, retcode);
    const data = object(payload.data);
    if (!data) invalid($t("zzz-tuning.text_8763ccd035"));
    if ((data.uid != null && text(data.uid) !== uid) || (data.region != null && text(data.region) !== region)) {
      invalid($t("zzz-tuning.text_042c6ef9ba"));
    }
    return data;
  }
  return { uid, region, request, check };
}

export async function readZzzTuningInventory(
  source: ProfileRequestContext, transport: HoyoTransport, options: ZzzTuningOptions = {}, guard?: Guard,
): Promise<{ uid: string; fetchedAt: string; inventory: ZzzTuningInventory }> {
  const { uid, request, check } = tuningRequest(source, transport, options, guard);
  const inventory = inventoryOf(await request("index"));
  await check();
  return { uid, fetchedAt: (options.now?.() ?? new Date()).toISOString(), inventory };
}

export async function readZzzTuning(
  source: ProfileRequestContext, transport: HoyoTransport, options: ZzzTuningOptions = {}, guard?: Guard,
): Promise<ZzzTuningSnapshot> {
  const { uid, region, request, check } = tuningRequest(source, transport, options, guard);
  const index = await request("index");
  const currentVersion = versionOf(index.cur_ver);
  const totalDraws = uint(index.total_gacha_count);
  const totalS = uint(index.total_s_count);
  if (totalDraws === null || totalS === null || totalDraws < totalS) invalid($t("zzz-tuning.text_b09f99a850"));
  const byType = new Map<Pool, Json>();
  for (const row of list(index.type_stats, $t("zzz-tuning.text_1f0503de86"))) {
    const band = object(row);
    const type = text(band?.gacha_type);
    if (!band || !type) invalid($t("zzz-tuning.text_48a6610cd3"));
    if (!Object.hasOwn(zzzTuningPools, type)) continue;
    const poolType = type as Pool;
    if (byType.has(poolType)) invalid($t("zzz-tuning.text_e9d285f473"));
    byType.set(poolType, band);
  }

  const types = Object.keys(zzzTuningPools) as Pool[];
  if (byType.size !== types.length) invalid($t("zzz-tuning.text_2ab9667838"));
  const inventory = inventoryOf(index);
  const pools: ZzzTuningPool[] = [];
  for (const type of types) {
    const band = byType.get(type)!;
    const versions = [...new Set(list(band.has_data_vers ?? [], "绝区零官方调频历史期次列表无效。")
      .map(versionOf))].filter((version) => version !== currentVersion);
    const gacha_type = String(zzzTuningPools[type].id);
    const periods = periodsOf(await request("cur_pool_stat", { gacha_type }));
    for (let start = 0; start < versions.length; start += batchSize) {
      const batch = versions.slice(start, start + batchSize);
      const history = periodsOf(await request("hist_pool_stat", { gacha_type, vers: batch.join(",") }));
      const returned = new Set(history.map(({ version }) => version));
      if ([...returned].some((version) => !batch.includes(version))) {
        invalid($t("zzz-tuning.text_ac9680b223"));
      }
      for (const version of batch.filter(version => !returned.has(version))) {
        const confirmed = periodsOf(await request("hist_pool_stat", { gacha_type, vers: version }));
        if (confirmed.some(period => period.version !== version)) invalid($t("zzz-tuning.text_ac9680b223"));
        history.push(...confirmed);
      }
      periods.push(...history);
    }
    pools.push(poolOf(type, band, periods));
  }

  const main = pools.filter(({ type }) => type !== "GACHA_TYPE_BANGBOO");
  if (main.reduce((sum, pool) => sum + pool.totalDraws, 0) !== totalDraws ||
      main.reduce((sum, pool) => sum + pool.totalS, 0) !== totalS) {
    invalid($t("zzz-tuning.text_ed1b37a28a"));
  }
  await check();
  return { version: 1, uid, region, profileId: source.profileId, currentVersion,
    totalDraws, totalS, inventory, pools, updatedAt: (options.now?.() ?? new Date()).toISOString() };
}
