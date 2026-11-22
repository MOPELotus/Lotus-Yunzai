import { isDeepStrictEqual } from "node:util";
import { starRailGachaPools } from "../packages/hoyo-client/starrail-gacha.ts";

type Json = Record<string, unknown>;
export type SummaryDirection = "to-old" | "to-modern";
export interface StarRailSummaryIdentity {
  readonly qq: string;
  readonly uid: string;
  readonly region: "prod_gf_cn" | "prod_qd_cn";
}

export class StarRailSummaryHandbackError extends Error {}
const format = "mihoyo_star_rail_gacha_miniapp";
const poolTypes = Object.keys(starRailGachaPools);
const timeFields = ["time", "legacy_time"] as const;
const credentials = /^(?:cookie|cookie_token(?:_v2)?|stoken(?:_v2)?|ltoken(?:_v2)?|authkey|login_ticket|stoken_cookie)$/iu;

function invalid(): never {
  throw new StarRailSummaryHandbackError("星铁官方汇总的格式、档案或区服无效。");
}

function conflict(): never {
  throw new StarRailSummaryHandbackError("两份星铁官方汇总不是同一档案的连续记录，或已有统计及明确字段冲突。");
}

function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Json;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function id(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value) invalid();
  return value;
}

export function parseStarRailSummary(bytes: Uint8Array) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), (key, value: unknown) => {
      if (credentials.test(key)) invalid();
      return value;
    }) as unknown;
  } catch {
    return invalid();
  }
}

function rows(value: unknown) {
  if (!Array.isArray(value)) invalid();
  const keyed = new Map<string, Json>();
  const entries = value.map((item) => {
    const row = object(item);
    for (const field of timeFields) {
      if (Object.hasOwn(row, field) && row[field] != null && typeof row[field] !== "string") invalid();
    }
    if (Object.hasOwn(row, "is_up") && typeof row.is_up !== "boolean") invalid();
    if (row.item != null) object(row.item);
    count(row.gacha_count);
    const rowId = id(row.id);
    const uuid = id(row.uuid);
    if (!rowId && !uuid) invalid();
    for (const key of [...(rowId ? [`id:${rowId}`] : []), ...(uuid ? [`uuid:${uuid}`] : [])]) {
      if (keyed.has(key)) conflict();
      keyed.set(key, row);
    }
    return { row, rowId, uuid };
  });
  return { keyed, entries };
}

function pool(value: unknown, type: string) {
  const data = object(value);
  if (data.name !== starRailGachaPools[type as keyof typeof starRailGachaPools] || !Array.isArray(data.cards)) invalid();
  const counters = new Map(Object.entries(object(data.cardCounters)).map(([key, value]) => {
    if (!id(key)) invalid();
    return [key, count(value)] as const;
  }));
  const total = count(data.totalDraws);
  const known = count([...counters.values()].reduce((sum, value) => sum + value, 0));
  if (total < known) invalid();
  count(data.pity);
  for (const value of data.cards) {
    const card = object(value);
    const key = id(card.gacha_id);
    const totalCount = count(card.total_count);
    count(card.up_count);
    if ((!key && totalCount > 0) || totalCount > (counters.get(key) ?? 0)) invalid();
  }
  const stars = rows(data.fiveStars);
  if (stars.entries.length > total) invalid();
  return { data, counters, total, known, stars };
}

function summary(value: unknown, identity: StarRailSummaryIdentity) {
  const data = object(value);
  const { qq, uid, region } = identity;
  if (!/^[1-9]\d{0,18}$/u.test(qq) || !/^[1-9]\d{8,9}$/u.test(uid) ||
      (region !== "prod_gf_cn" && region !== "prod_qd_cn") ||
      data.version !== 1 || data.source !== format || data.qq !== qq || data.uid !== uid || data.region !== region) invalid();
  const profileId = count(data.profileId);
  if (profileId < 1 || profileId > 255 || typeof data.updatedAt !== "string") invalid();
  const updatedAt = Date.parse(data.updatedAt);
  if (!Number.isFinite(updatedAt) || new Date(updatedAt).toISOString() !== data.updatedAt) invalid();
  const brief = object(data.brief);
  if (typeof brief.version_id !== "string" || !Array.isArray(brief.items)) invalid();
  const pools = object(data.pools);
  if (Object.keys(pools).length !== poolTypes.length) invalid();
  return { data, profileId, updatedAt, pools: new Map(poolTypes.map(type => [type, pool(pools[type], type)])) };
}

function matching(next: ReturnType<typeof rows>, rowId: string, uuid: string) {
  const byId = rowId ? next.keyed.get(`id:${rowId}`) : undefined;
  const byUuid = uuid ? next.keyed.get(`uuid:${uuid}`) : undefined;
  const found = byId ?? byUuid;
  if (!found || (byId && byUuid && byId !== byUuid) ||
      (rowId && found.id && found.id !== rowId) || (uuid && found.uuid && found.uuid !== uuid)) conflict();
  return found;
}

/** Compare consecutive snapshots from the same stopped-installation handoff. */
export function prepareStarRailSummaryHandback(baseline: unknown, later: unknown, identity: StarRailSummaryIdentity,
  direction: SummaryDirection) {
  const before = summary(baseline, identity);
  const after = summary(later, identity);
  if (before.profileId !== after.profileId || after.updatedAt < before.updatedAt) conflict();
  const counts = { retained: 0, added: 0, restoredTimes: 0, restoredUnknownUp: 0 };
  const pools: Json = {};
  for (const [type, first] of before.pools) {
    const last = after.pools.get(type)!;
    if (last.total - last.known < first.total - first.known ||
        [...first.counters].some(([key, value]) => (last.counters.get(key) ?? -1) < value)) conflict();
    const repaired = new Map<Json, Json>();
    for (const { row, rowId, uuid } of first.stars.entries) {
      const next = matching(last.stars, rowId, uuid);
      if (repaired.has(next) || (row.item != null && !isDeepStrictEqual(row.item, next.item)) ||
          (row.got_item != null && !isDeepStrictEqual(row.got_item, next.got_item)) || row.gacha_count !== next.gacha_count) conflict();
      const priorTime = row.time || row.legacy_time;
      const foundTime = next.time || next.legacy_time;
      if (priorTime && foundTime && priorTime !== foundTime) conflict();
      if (typeof row.is_up === "boolean" && typeof next.is_up === "boolean" && row.is_up !== next.is_up) conflict();
      if (direction === "to-modern" && row.is_up === undefined && next.is_up === true) conflict();
      if (direction === "to-old" && ((priorTime && !foundTime) ||
          (typeof row.is_up === "boolean" && next.is_up === undefined) ||
          (rowId && !next.id) || (uuid && !next.uuid))) conflict();
      const result: Json = { ...row, ...next, id: next.id || rowId, uuid: next.uuid || uuid };
      if (direction === "to-modern") {
        if (priorTime && !foundTime) {
          for (const field of timeFields) if (row[field]) result[field] = row[field];
          counts.restoredTimes++;
        }
        // A fixed old writer coerces an omitted marker to false. Preserve the known third state.
        if (row.is_up === undefined && next.is_up === false) {
          delete result.is_up;
          counts.restoredUnknownUp++;
        }
      }
      repaired.set(next, result);
    }
    counts.retained += repaired.size;
    counts.added += last.stars.entries.length - repaired.size;
    pools[type] = { ...first.data, ...last.data, fiveStars: last.stars.entries.map(({ row }) => repaired.get(row) ?? row) };
  }
  const document = direction === "to-modern" ? { ...before.data, ...after.data, pools } : undefined;
  return { counts, document: document && !isDeepStrictEqual(document, after.data) ? document : undefined };
}
