import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";
import type { ZzzShiyuPortrait } from "./zzz-shiyu.ts";

type Json = Record<string, unknown>;
type Identity = { readonly uid: string; readonly region: string };
export type ZzzZenkovMode = "summary" | "detail";
export const zzzZenkovPageSize = 6;
const initialPages = 3;

interface Progress { readonly current?: number; readonly total?: number }
export interface ZzzZenkovRank { readonly value: number; readonly percent: boolean }
export interface ZzzZenkovItem {
  readonly name?: string;
  readonly icon?: string;
  readonly rarity?: number;
  readonly unlocked?: boolean;
  readonly count?: number;
  readonly price?: string;
}
export interface ZzzZenkovMap {
  readonly name?: string;
  readonly unlocked?: boolean;
  readonly evacuation?: number;
  readonly price?: string;
  readonly rank?: ZzzZenkovRank;
}
export interface ZzzZenkovRun {
  readonly map?: string;
  readonly started?: string;
  readonly seconds?: number;
  readonly difficulty?: string;
  readonly success?: boolean;
  readonly value?: string;
  readonly avatars: readonly ZzzShiyuPortrait[];
  readonly loot: readonly ZzzZenkovItem[];
  readonly hiddenLoot: number;
}
interface Collection extends Progress {
  readonly items: readonly ZzzZenkovItem[];
  readonly hiddenItems: number;
}

type Shared = Identity & {
  readonly status: "available" | "empty";
  readonly maps: readonly ZzzZenkovMap[];
  readonly hiddenMaps: number;
  readonly rank?: ZzzZenkovRank;
};

export type ZzzZenkovSnapshot = Shared & (
  { readonly kind: "summary"; readonly seasonUnlocked?: boolean; readonly season?: {
      readonly id?: number; readonly level?: number; readonly stage?: number; readonly remaining?: number;
      readonly quest?: Progress; readonly coin?: Progress };
    readonly weeklyRemaining?: number; readonly duty?: Progress; readonly carryValue?: string;
    readonly zGrade?: number; readonly millionEvacuations?: number; readonly medals?: Collection; readonly goods?: Collection } |
  { readonly kind: "detail"; readonly records: readonly ZzzZenkovRun[]; readonly totalRecords: number; readonly pageCount: number; readonly firstPage: number }
);

function invalid(field: string): never {
  throw new HoyoRequestError("response", `官方迷宫诡域响应的${field}无效。`);
}

function object(value: unknown, field: string): Json | undefined {
  if (value == null) return;
  if (typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Json;
}

function list(value: unknown, field: string): readonly unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid(field);
  return value;
}

function count(value: unknown, field: string, maximum = 999_999_999) {
  if (value == null) return;
  const parsed = typeof value === "string" && /^\d{1,10}$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) invalid(field);
  return parsed;
}

function money(value: unknown) {
  if (value == null || value === "") return;
  if (typeof value === "string" && /^\d{1,30}$/u.test(value)) return value.replace(/^0+(?=\d)/u, "");
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  invalid("物资金额");
}

function text(value: unknown, limit = 1024) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const clean = value.trim();
  if (clean && Buffer.byteLength(clean) <= limit) return clean;
}

function flag(value: unknown) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
}

function progress(value: unknown, suffix: string): Progress | undefined {
  const row = object(value, suffix);
  if (row) return { current: count(row[`cur_${suffix}`], suffix), total: count(row[`max_${suffix}`], suffix) };
}

function rank(row: Json): ZzzZenkovRank | undefined {
  const percent = flag(row.is_show_percent) === true;
  const value = count(row.max_rank, "排名", percent ? 10_000 : 999_999_999);
  if (value) return { value, percent };
}

function item(row: Json, icon: string): ZzzZenkovItem {
  return { name: text(row.name, 120), icon: text(row[icon]), rarity: count(row.rarity, "稀有度", 99),
    unlocked: flag(row.unlock), count: count(row.number, "物品数"), price: money(row.price) };
}

function collection(value: unknown, icon: string): Collection | undefined {
  const row = object(value, "珍品图鉴");
  if (!row) return;
  const entries = list(row.list, "收藏");
  return { current: count(row.cur, "收藏数"), total: count(row.total, "收藏总数"),
    items: entries.slice(0, 48).map(entry => item(object(entry, "收藏项") ?? invalid("收藏项"), icon)),
    hiddenItems: Math.max(0, entries.length - 48) };
}

function time(value: unknown, calendar: true): string | undefined;
function time(value: unknown, calendar: false): number | undefined;
function time(value: unknown, calendar: boolean) {
  const row = object(value, calendar ? "开始时刻" : "耗时");
  if (!row) return;
  const hours = count(row.hour, "小时", calendar ? 23 : 999) ?? 0;
  const minutes = count(row.minute, "分钟", 59) ?? 0;
  const seconds = count(row.second, "秒", 59) ?? 0;
  if (!calendar) {
    if (row.hour == null && row.minute == null && row.second == null) return;
    return hours * 3600 + minutes * 60 + seconds;
  }
  const year = count(row.year, "年", 9999);
  const month = count(row.month, "月", 12);
  const day = count(row.day, "日", 31);
  if (!year || !month || !day) return;
  if (year < 2024) invalid("开始时刻");
  const datetime = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
  if (datetime.getUTCMonth() !== month - 1) invalid("开始时刻");
  return datetime.toISOString().slice(0, 19).replace("T", " ");
}

function avatar(value: unknown): ZzzShiyuPortrait | undefined {
  const row = object(value, "代理人");
  if (!row) return;
  const id = count(row.id, "代理人编号", 999_999);
  const icon = text(row.role_square_url);
  const name = text(row.name_mi18n ?? row.name, 96);
  if (!id && !icon && !name) return;
  return { itemId: id ? String(id) : undefined, icon, name, rank: count(row.rank, "影画", 99) };
}

function run(value: unknown): ZzzZenkovRun {
  const row = object(value, "探索记录") ?? invalid("探索记录");
  const loot = list(row.item_list, "调查收获");
  const difficulty = text(row.difficult, 32);
  return { map: text(row.map_name, 96), started: time(row.start_time, true), seconds: time(row.challenge_time, false),
    difficulty: difficulty === "Hell" ? "高危" : difficulty === "Hard" ? "困难" :
      difficulty === "Easy" || difficulty === "Normal" ? "普通" : difficulty,
    success: flag(row.is_success), value: money(row.material_total_value),
    avatars: list(row.avatar_list, "阵容").slice(0, 3).flatMap(entry => avatar(entry) ?? []),
    loot: loot.slice(0, 18).map(entry => item(object(entry, "调查收获项") ?? invalid("调查收获项"), "icon_url")),
    hiddenLoot: Math.max(0, loot.length - 18) };
}

export function normalizeZzzZenkov(input: unknown, identity: Identity, kind: ZzzZenkovMode, page?: number): ZzzZenkovSnapshot {
  if (page !== undefined && (kind !== "detail" || !Number.isSafeInteger(page) || page < 1)) {
    throw new HoyoRequestError("invalid-input", "迷宫诡域战绩页码无效。");
  }
  const data = object(input, "格式") ?? invalid("格式");
  for (const key of ["uid", "role_id", "game_uid"]) {
    const value = data[key];
    if (value !== undefined && ((typeof value !== "string" && typeof value !== "number") || String(value) !== identity.uid)) {
      invalid("档案 UID");
    }
  }
  for (const key of ["region", "server"]) {
    if (data[key] !== undefined && data[key] !== identity.region) invalid("档案区服");
  }
  if (data.game_biz !== undefined && data.game_biz !== "nap_cn") invalid("游戏标识");
  const maps = list(data.map_list, "地图");
  const shared = { ...identity, rank: rank(data), hiddenMaps: Math.max(0, maps.length - 24), maps: maps.slice(0, 24).map(entry => {
    const row = object(entry, "地图项") ?? invalid("地图项");
    return { name: text(row.map_name, 96), unlocked: flag(row.hell_unlock), evacuation: count(row.leave_percent, "撤离率", 10_000),
      price: money(row.max_price), rank: rank(row) };
  }) };
  if (kind === "detail") {
    const records = list(data.record_list, "探索记录");
    const firstPage = page ?? 1;
    const pageCount = Math.max(1, Math.ceil(records.length / zzzZenkovPageSize));
    const start = firstPage <= pageCount ? (firstPage - 1) * zzzZenkovPageSize : records.length;
    const end = start + (page === undefined ? initialPages : 1) * zzzZenkovPageSize;
    return { ...shared, kind, status: shared.maps.length || shared.rank || records.length ? "available" : "empty",
      records: records.slice(start, end).map(run), totalRecords: records.length, pageCount, firstPage };
  }
  const seasonRow = object(data.season_data, "赛季");
  const seasonUnlocked = flag(data.season_unlock);
  const season = seasonRow && { id: count(seasonRow.cur_season_id, "赛季编号"), level: count(seasonRow.season_level, "赛季等级"),
    stage: count(seasonRow.season_stage, "阶段"), remaining: count(seasonRow.refresh_time, "赛季剩余时间"),
    quest: progress(seasonRow.season_quest, "quest"), coin: progress(seasonRow.season_coin, "coin") };
  const weeklyRemaining = count(data.refresh_time, "本周剩余时间");
  const duty = progress(data.abyss_duty, "duty");
  const carryValue = money(data.collect_total_value);
  // 官方概况未提供累计统计时返回空串；保留缺失语义，不将其当作实际零值。
  const zGrade = count(data.big_red_num === "" ? undefined : data.big_red_num, "Z级贵重物品");
  const millionEvacuations = count(data.millions_evacuations === "" ? undefined : data.millions_evacuations, "百万撤离");
  const collected = object(data.collection_data, "珍品图鉴");
  const medals = collection(collected?.medal_data, "medal_icon");
  const goods = collection(collected?.goods_data, "goods_icon");
  const available = [seasonUnlocked, season, weeklyRemaining, duty, carryValue, zGrade, millionEvacuations, medals, goods, shared.rank]
    .some(value => value !== undefined) || shared.maps.length > 0;
  return { ...shared, kind, status: available ? "available" : "empty", seasonUnlocked, season, weeklyRemaining, duty, carryValue,
    zGrade, millionEvacuations, medals, goods };
}

export async function readZzzZenkov(source: ProfileRequestContext, transport: HoyoTransport,
  { kind, page, signal }: { readonly kind: ZzzZenkovMode; readonly page?: number; readonly signal?: AbortSignal }, verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport,
    { kind: kind === "summary" ? "zzz-zenkov" : "zzz-zenkov-detail", signal }, verifyProfile);
  return normalizeZzzZenkov(data, { uid: source.role.uid, region }, kind, page);
}
