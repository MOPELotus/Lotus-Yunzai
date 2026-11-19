import type { MiyousheOverviewTarget } from "./miyoushe-overview.ts";

export const trackingGames = { hk4e: "hk4e_cn", hkrpg: "hkrpg_cn", nap: "nap_cn", bh3: "bh3_cn", bh2: "bh2_cn", nxx: "nxx_cn" } as const;
export const trackingProfileGames = { hk4e: "gs", hkrpg: "sr", nap: "zzz", bh3: "bh3", bh2: "bh2", nxx: "nxx" } as const;
export type TrackingGame = keyof typeof trackingGames;
export type TrackingRole = { readonly uid: string; readonly region: string; readonly gameBiz: string };

export interface TrackingGood {
  readonly id: string; readonly name: string; readonly type: number | null; readonly gameBiz: string; readonly game?: string;
  readonly price: number; readonly status: "available" | "scheduled" | "ended" | "sold_out" | "unknown";
  readonly opensAt: number | null; readonly serverNow?: number; readonly limitCycle?: string; readonly roleCycle?: string;
  readonly saleStartsAt?: number | null; readonly startsAt?: number | null;
}

export interface ShopTracker extends MiyousheOverviewTarget {
  readonly id: string;
  readonly accountId: string;
  readonly mode: "goods" | "category";
  readonly game: TrackingGame;
  readonly itemType: 1 | 2;
  readonly goodsIds: readonly string[];
  readonly names: readonly string[];
  readonly keywords: readonly string[];
  readonly followSameName: boolean;
  readonly maxPrice: number | null;
  readonly spendLimit: number | null;
  readonly role: TrackingRole | null;
  readonly gameBiz: string;
  readonly addressId: string;
  readonly addressLabel: string;
  readonly pollMs: number;
  readonly pollUnit: "minutes";
  readonly leadMs: number;
  readonly intervalMs: number;
  readonly createdAt: number;
  confirmation?: { bindingStamp: string; at: number };
  enabled: boolean;
  message: string;
  nextPollAt?: number;
  lastPolledAt?: number;
  nextOpenAt?: number;
  matchedCount?: number;
}

const numericId = /^[1-9]\d{0,19}$/u;
const code = /^[a-zA-Z0-9_]{1,32}$/u;
const digest = /^[a-f0-9]{64}$/u;
export const trackerId = /^[a-f0-9]{12}$/u;
const minutes = 60_000;
export const defaultPoll = 30 * minutes;

export function asTrackerRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function strings(value: unknown, max: number, accept: (text: string) => boolean): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(item => typeof item === "string" && accept(item));
}

function text(value: string) { return value.normalize("NFKC").toLowerCase().trim(); }
function short(value: string) { return value.length <= 80 && !/[\p{Cc}\p{Cf}]/u.test(value); }
function limit(value: unknown) { return value === null || integer(value); }

export function trackingGame(value: unknown): value is TrackingGame {
  return typeof value === "string" && Object.hasOwn(trackingGames, value);
}

export function readTrackingInput(value: unknown) {
  const row = asTrackerRecord(value);
  if (!row || row.confirmed !== true || !trackingGame(row.game) || (row.itemType !== 1 && row.itemType !== 2) ||
    (row.mode !== "category" && row.mode !== "goods") || !strings(row.goodsIds, 20, id => numericId.test(id)) ||
    !strings(row.keywords, 10, short) || (row.mode === "goods" ? !row.goodsIds.length || row.keywords.length : row.goodsIds.length) ||
    typeof row.followSameName !== "boolean" || !limit(row.maxPrice) || !limit(row.spendLimit) ||
    !integer(row.pollMinutes, 1, 1440) || !integer(row.leadSeconds, 0, 30) || !integer(row.intervalMs, 250, 5000) ||
    (row.itemType === 1 ? !string(row.addressId, numericId) : row.addressId !== "" && row.addressId !== undefined)) return;
  return { mode: row.mode as ShopTracker["mode"], game: row.game, itemType: row.itemType as ShopTracker["itemType"],
    goodsIds: [...new Set(row.goodsIds)], keywords: [...new Set(row.keywords.map(word => word.trim()).filter(Boolean))],
    followSameName: row.mode === "goods" && row.followSameName, maxPrice: row.maxPrice as number | null,
    spendLimit: row.spendLimit as number | null, pollMs: row.pollMinutes * minutes, pollUnit: "minutes" as const,
    leadMs: row.leadSeconds * 1000, intervalMs: row.intervalMs, addressId: row.addressId as string | undefined };
}

export function trackingRule(value: unknown): ShopTracker | undefined {
  const row = asTrackerRecord(value);
  if (!row || !string(row.id, trackerId) || !string(row.qq, numericId) || !integer(row.profileId, 1, 255) ||
    !string(row.accountId, numericId) || !trackingGame(row.game) || (row.itemType !== 1 && row.itemType !== 2) ||
    (row.mode !== "category" && row.mode !== "goods") || !strings(row.goodsIds, 20, id => numericId.test(id)) ||
    !strings(row.names, 20, name => name.length <= 240 && !/[\p{Cc}\p{Cf}]/u.test(name)) ||
    !strings(row.keywords, 10, short) || (row.mode === "goods" && !row.goodsIds.length) ||
    !limit(row.maxPrice) || !limit(row.spendLimit) || typeof row.followSameName !== "boolean" ||
    !integer(row.createdAt) || typeof row.enabled !== "boolean") return;
  if (row.itemType === 1) {
    if (!string(row.addressId, numericId)) return;
  } else {
    const role = asTrackerRecord(row.role);
    if (!role || row.gameBiz !== trackingGames[row.game] || role.gameBiz !== row.gameBiz || !string(role.uid, numericId) ||
      !string(role.region, code)) return;
  }
  return { ...row,
    pollUnit: "minutes", pollMs: row.pollUnit === "minutes" && integer(row.pollMs, minutes, 1440 * minutes) ? row.pollMs : defaultPoll,
    leadMs: integer(row.leadMs, 0, 30_000) ? row.leadMs : 5_000,
    intervalMs: integer(row.intervalMs, 250, 5000) ? row.intervalMs : 500,
  } as unknown as ShopTracker;
}

export function confirmedTracker(rule: ShopTracker | undefined): rule is ShopTracker & { confirmation: { bindingStamp: string; at: number } } {
  return !!rule && !!rule.confirmation && string(rule.confirmation.bindingStamp, digest) && integer(rule.confirmation.at);
}

export function matchesTrackingGood(rule: Pick<ShopTracker, "game" | "itemType" | "mode" | "maxPrice" | "goodsIds" | "names" | "keywords" | "followSameName">,
  good: TrackingGood) {
  if (good.type !== rule.itemType || (good.game ? good.game !== rule.game : good.gameBiz !== trackingGames[rule.game]) ||
    (good.type === 2 && good.gameBiz !== trackingGames[rule.game]) || (rule.maxPrice !== null && good.price > rule.maxPrice)) return false;
  if (rule.mode === "goods") {
    return rule.goodsIds.includes(good.id) || (rule.followSameName && rule.names.some(name => text(name) === text(good.name)));
  }
  return !rule.keywords.length || rule.keywords.some(word => text(good.name).includes(text(word)));
}

export function trackingCycle(good: TrackingGood, now: number) {
  const rank = (period: string) => {
    if (period === "not_limit") return 0;
    if (period === "day" || period === "daily") return 1;
    if (period === "week" || period === "weekly") return 2;
    if (period === "month" || period === "monthly") return 3;
    return 4;
  };
  const limit = good.limitCycle && good.roleCycle && rank(good.roleCycle) > rank(good.limitCycle) ? good.roleCycle : good.limitCycle;
  const at = good.status === "scheduled" ? good.opensAt : good.serverNow ?? now;
  if (!integer(at, 0, 253_402_271_999_999) || !limit) return;
  const date = new Date(at + 8 * 3_600_000);
  if (limit === "day" || limit === "daily") return `${good.id}:day:${date.toISOString().slice(0, 10)}`;
  if (limit === "week" || limit === "weekly") {
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    return `${good.id}:week:${date.toISOString().slice(0, 10)}`;
  }
  if (limit === "month" || limit === "monthly") return `${good.id}:month:${date.toISOString().slice(0, 7)}`;
  if (limit === "not_limit") {
    const batch = good.saleStartsAt || good.startsAt;
    if (integer(batch, 1)) return `${good.id}:batch:${batch}`;
    if (good.status === "scheduled") return;
  }
  return `${good.id}:forever`;
}
