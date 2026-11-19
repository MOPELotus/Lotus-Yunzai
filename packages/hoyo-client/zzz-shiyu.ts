import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

type Json = Record<string, unknown>;
export type ZzzShiyuDate = string;
export type ZzzShiyuRating = "S+" | "S" | "A+" | "A" | "B" | "C" | "D";
export interface ZzzShiyuPortrait {
  readonly itemId?: string;
  readonly name?: string;
  readonly icon?: string;
  readonly rarity?: "S" | "A" | "B";
  readonly rank?: number;
}
export interface ZzzShiyuTeam {
  readonly avatars: readonly (ZzzShiyuPortrait | undefined)[];
  readonly buddy?: ZzzShiyuPortrait;
  readonly monster?: string;
  readonly rating?: ZzzShiyuRating;
  readonly score?: number;
  readonly challengeTime?: ZzzShiyuDate;
  readonly battleTime?: number;
  readonly buff?: string;
}
export interface ZzzShiyuLayer {
  readonly number: 1 | 2 | 3 | 4 | 5;
  readonly rating?: ZzzShiyuRating;
  readonly challengeTime?: ZzzShiyuDate;
  readonly teams: readonly ZzzShiyuTeam[];
}
export interface ZzzShiyuSnapshot {
  readonly uid: string;
  readonly region: string;
  readonly scheduleType: 1 | 2;
  readonly status: "available" | "empty" | "older-format";
  readonly period?: { readonly start: ZzzShiyuDate; readonly end: ZzzShiyuDate };
  readonly overall?: {
    readonly rating?: ZzzShiyuRating;
    readonly score?: number;
    readonly rankBasisPoints?: number;
    readonly challengeTime?: ZzzShiyuDate;
    readonly battleTime?: number;
  };
  readonly layers: readonly ZzzShiyuLayer[];
}

const layerKeys = ["fitfh", "fourth", "third", "second", "first"] as const;
const knownRatings: ReadonlySet<string> = new Set(["S+", "S", "A+", "A", "B", "C", "D"]);
const chineseHours = 8 * 60 * 60;

function invalid(message = "官方式舆防卫战响应的战绩格式无效。"): never {
  throw new HoyoRequestError("response", message);
}

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function whole(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  const parsed = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum) return parsed;
}

function cleanText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const text = value.trim();
  if (text && Buffer.byteLength(text) <= limit) return text;
}

// Structured times from the CN battle record are already in China Standard Time.
// Older copies can retain only Unix seconds on some rows.
function date(value: unknown): ZzzShiyuDate | undefined {
  const fields = object(value);
  if (!fields) {
    const epoch = whole(value, 4_102_444_799);
    if (epoch !== undefined && epoch >= 1_700_000_000) {
      return new Date((epoch + chineseHours) * 1000).toISOString().slice(0, 19).replace("T", " ");
    }
    return;
  }
  const year = whole(fields.year, 2099);
  const month = whole(fields.month, 12);
  const day = whole(fields.day, 31);
  const hour = whole(fields.hour, 23);
  const minute = whole(fields.minute, 59);
  const second = whole(fields.second, 59);
  if (!year || year < 2024 || !month || !day || hour === undefined || minute === undefined || second === undefined) return;
  const time = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (time.getUTCMonth() !== month - 1) return;
  return time.toISOString().slice(0, 19).replace("T", " ");
}

function rating(value: unknown): ZzzShiyuRating | undefined {
  if (typeof value === "string" && knownRatings.has(value)) return value as ZzzShiyuRating;
}

function verifyIdentity(data: Json, { uid, region, scheduleType }: Pick<ZzzShiyuSnapshot, "uid" | "region" | "scheduleType">) {
  for (const key of ["uid", "role_id", "game_uid"]) {
    const value = data[key];
    if (value !== undefined && value !== uid && (typeof value !== "number" || String(value) !== uid)) {
      invalid("官方式舆防卫战响应的 UID 与当前档案不一致。");
    }
  }
  for (const key of ["server", "region"]) {
    if (data[key] !== undefined && data[key] !== region) invalid("官方式舆防卫战响应的区服与当前档案不一致。");
  }
  if (data.game_biz !== undefined && data.game_biz !== "nap_cn") invalid("官方式舆防卫战响应的游戏与当前档案不一致。");
  if (data.schedule_type !== undefined && whole(data.schedule_type) !== scheduleType) {
    invalid("官方式舆防卫战响应的周期选择与查询不一致。");
  }
}

function portrait(value: unknown, kind: "avatar" | "buddy"): ZzzShiyuPortrait | undefined {
  const entry = object(value);
  if (!entry) return;
  const id = whole(entry.id, 999_999);
  const icon = cleanText(kind === "avatar" ? entry.role_square_url : entry.bangboo_rectangle_url ?? entry.bangboo_square_url, 1024);
  if (!id && !icon) return;
  const rarity = entry.rarity;
  return {
    itemId: id ? String(id) : undefined, icon, name: cleanText(entry.name_mi18n ?? entry.name, 96),
    rarity: rarity === "A" || rarity === "B" || rarity === "S" ? rarity : undefined,
    rank: kind === "avatar" ? whole(entry.rank, 99) : undefined,
  };
}

function readTeam(value: unknown): ZzzShiyuTeam {
  const item = object(value);
  if (!item) invalid();
  const avatars = item.avatar_list ?? [];
  if (!Array.isArray(avatars) || avatars.length > 3) invalid();
  return {
    avatars: avatars.map(entry => portrait(entry, "avatar")),
    buddy: portrait(item.buddy, "buddy"),
    monster: cleanText(item.monster_pic, 1024),
    rating: rating(item.rating), score: whole(item.score, 999_999_999),
    challengeTime: date(item.challenge_time), battleTime: whole(item.battle_time, 86_400),
    buff: cleanText(object(item.buffer)?.title, 224),
  };
}

function readLayers(data: Json): readonly ZzzShiyuLayer[] {
  const numbers = [5, 4, 3, 2, 1] as const;
  return layerKeys.flatMap((key, index) => {
    const number = numbers[index]!;
    const raw = data[`${key}_layer_detail`] ?? (key === "fitfh" ? data.fifth_layer_detail : undefined);
    if (raw === undefined || raw === null) return [];
    const layer = object(raw);
    if (!layer) invalid();
    const teams = layer.layer_challenge_info_list;
    if (teams === undefined || teams === null) return [];
    if (!Array.isArray(teams) || teams.length > (number === 5 ? 3 : 2)) invalid();
    if (!teams.length) return [];
    return [{ number, rating: rating(layer.rating), challengeTime: date(layer.challenge_time), teams: teams.map(readTeam) }];
  });
}

export function normalizeZzzShiyu(input: unknown, identity: Pick<ZzzShiyuSnapshot, "uid" | "region" | "scheduleType">): ZzzShiyuSnapshot {
  const payload = object(input);
  if (!payload) invalid();
  verifyIdentity(payload, identity);
  if (payload.hadal_ver !== "v2") {
    if (typeof payload.hadal_ver !== "string" || !payload.hadal_ver) invalid();
    return { ...identity, status: "older-format", layers: [] };
  }
  if (payload.hadal_info_v2 === null || payload.hadal_info_v2 === undefined) {
    return { ...identity, status: "empty", layers: [] };
  }
  const data = object(payload.hadal_info_v2);
  if (!data) invalid();
  verifyIdentity(data, identity);
  const start = date(data.hadal_begin_time) ?? date(data.begin_time);
  const end = date(data.hadal_end_time) ?? date(data.end_time);
  if (start && end && start >= end) invalid("官方式舆防卫战响应的统计周期无效。");

  const layers = readLayers(data);
  const brief = object(data.brief);
  return {
    ...identity,
    status: layers.length ? "available" : "empty",
    period: start && end ? { start, end } : undefined,
    overall: brief && {
      rating: rating(brief.rating),
      score: whole(brief.score, 999_999_999),
      rankBasisPoints: whole(brief.rank_percent, 10_000),
      challengeTime: date(brief.challenge_time),
      battleTime: whole(brief.battle_time, 86_400),
    },
    layers,
  };
}

// ZZZure/ZZZ-Plugin 2057599 dist/apps/abyss.js uses schedule_type 1 for current, 2 for previous.
export async function readZzzShiyu(source: ProfileRequestContext, transport: HoyoTransport,
  { scheduleType, signal }: { readonly scheduleType: 1 | 2; readonly signal?: AbortSignal }, verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "zzz-hadal", scheduleType, signal }, verifyProfile);
  return normalizeZzzShiyu(data, { uid: source.role.uid, region, scheduleType });
}
