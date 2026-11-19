import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";
import type { ZzzShiyuPortrait } from "./zzz-shiyu.ts";

type Json = Record<string, unknown>;

export interface ZzzDeadlyRoom {
  readonly name?: string;
  readonly bossIcon?: string;
  readonly bossBackground?: string;
  readonly raceIcon?: string;
  readonly buffIcon?: string;
  readonly buffName?: string;
  readonly score?: number;
  readonly stars?: number;
  readonly availableStars?: number;
  readonly clearedAt?: string;
  readonly avatars: readonly (ZzzShiyuPortrait | undefined)[];
  readonly buddy?: ZzzShiyuPortrait;
}

export interface ZzzDeadlySnapshot {
  readonly uid: string;
  readonly region: string;
  readonly scheduleType: 1 | 2;
  readonly status: "available" | "empty";
  readonly activityId?: number;
  readonly nickname?: string;
  readonly avatar?: string;
  readonly period?: { readonly start: string; readonly end: string };
  readonly totalScore?: number;
  readonly totalStars?: number;
  readonly trialRank?: number;
  readonly hardRank?: number;
  readonly trial: readonly ZzzDeadlyRoom[];
  readonly hard: readonly ZzzDeadlyRoom[];
}

type Identity = Pick<ZzzDeadlySnapshot, "uid" | "region" | "scheduleType">;

function invalid(message = "官方危局强袭战响应的战绩格式无效。"): never {
  throw new HoyoRequestError("response", message);
}

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function count(value: unknown, maximum: number): number | undefined {
  const normalized = typeof value === "string" && /^\d{1,10}$/u.test(value) ? Number(value) : value;
  if (typeof normalized === "number" && Number.isSafeInteger(normalized) && normalized >= 0 && normalized <= maximum) return normalized;
}

function text(value: unknown, limit = 1024) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const cleaned = value.trim();
  if (cleaned && Buffer.byteLength(cleaned) <= limit) return cleaned;
}

function time(value: unknown) {
  const item = object(value);
  if (!item) return;
  const year = count(item.year, 2099);
  const month = count(item.month, 12);
  const day = count(item.day, 31);
  const hour = count(item.hour, 23);
  const minute = count(item.minute, 59);
  const second = count(item.second, 59);
  if (!year || year < 2024 || !month || !day || hour === undefined || minute === undefined || second === undefined) return;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCMonth() !== month - 1) return;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function verifyIdentity(data: Json, identity: Identity) {
  for (const field of ["uid", "role_id", "game_uid"]) {
    const value = data[field];
    if (value !== undefined && value !== identity.uid && (typeof value !== "number" || String(value) !== identity.uid)) {
      invalid("官方危局强袭战响应的 UID 与当前档案不一致。");
    }
  }
  for (const field of ["server", "region"]) {
    if (data[field] !== undefined && data[field] !== identity.region) invalid("官方危局强袭战响应的区服与当前档案不一致。");
  }
  if (data.game_biz !== undefined && data.game_biz !== "nap_cn") invalid("官方危局强袭战响应的游戏与当前档案不一致。");
  if (data.schedule_type !== undefined && count(data.schedule_type, 2) !== identity.scheduleType) {
    invalid("官方危局强袭战响应的周期选择与查询不一致。");
  }
}

function portrait(value: unknown, buddy: boolean): ZzzShiyuPortrait | undefined {
  const data = object(value);
  if (!data) return;
  const id = count(data.id, 999_999);
  const icon = text(buddy ? data.bangboo_rectangle_url ?? data.bangboo_square_url : data.role_square_url);
  if (!id && !icon) return;
  const rarity = data.rarity;
  return {
    itemId: id ? String(id) : undefined, icon,
    name: text(data.name_mi18n ?? data.name, 96),
    rarity: rarity === "S" || rarity === "A" || rarity === "B" ? rarity : undefined,
    rank: buddy ? undefined : count(data.rank, 99),
  };
}

function first(value: unknown) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) invalid();
  return object(value[0]);
}

function rooms(value: unknown): readonly ZzzDeadlyRoom[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 3) invalid();
  return value.map((entry) => {
    const data = object(entry);
    if (!data) invalid();
    const avatars = data.avatar_list ?? [];
    if (!Array.isArray(avatars) || avatars.length > 3) invalid();
    const stars = count(data.star, 9);
    const availableStars = count(data.total_star, 9);
    if (stars !== undefined && availableStars !== undefined && stars > availableStars) {
      invalid("官方危局强袭战响应的星级无效。");
    }
    const boss = first(data.boss);
    const buff = first(data.buffer);
    return {
      name: text(boss?.name, 192), bossIcon: text(boss?.icon), bossBackground: text(boss?.bg_icon), raceIcon: text(boss?.race_icon),
      buffIcon: text(buff?.icon), buffName: text(buff?.name, 128),
      score: count(data.score, 999_999_999), stars, availableStars, clearedAt: time(data.challenge_time),
      avatars: avatars.map(value => portrait(value, false)), buddy: portrait(data.buddy, true),
    };
  });
}

export function normalizeZzzDeadly(input: unknown, identity: Identity): ZzzDeadlySnapshot {
  const data = object(input);
  if (!data || typeof data.has_data !== "boolean") invalid();
  verifyIdentity(data, identity);
  if (!data.has_data) return { ...identity, status: "empty", trial: [], hard: [] };
  if (data.has_hard !== undefined && typeof data.has_hard !== "boolean") invalid();

  const start = time(data.start_time);
  const end = time(data.end_time);
  if (start && end && start >= end) invalid("官方危局强袭战响应的统计周期无效。");
  const hard = data.has_hard ? rooms(data.hard_list) : [];
  return {
    ...identity,
    status: "available",
    activityId: count(data.zone_id, 999_999_999),
    nickname: text(data.nick_name, 192),
    avatar: text(data.avatar_icon),
    period: start && end ? { start, end } : undefined,
    totalScore: count(data.total_score, 999_999_999),
    totalStars: count(data.total_star, 99),
    trialRank: count(data.rank_percent, 10_000),
    hardRank: hard.length ? count(data.hard_rank_percent, 10_000) : undefined,
    trial: rooms(data.list),
    hard,
  };
}

// ZZZure/ZZZ-Plugin 2057599 dist/apps/deadly.js uses schedule_type 1 for current, 2 for previous.
export async function readZzzDeadly(source: ProfileRequestContext, transport: HoyoTransport,
  { scheduleType, signal }: { readonly scheduleType: 1 | 2; readonly signal?: AbortSignal }, verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "zzz-deadly", scheduleType, signal }, verifyProfile);
  return normalizeZzzDeadly(data, { uid: source.role.uid, region, scheduleType });
}
