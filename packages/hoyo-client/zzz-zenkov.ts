import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
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
  throw new HoyoRequestError("response", $t("zzz-zenkov.text_cc17f034d7", { "field": field }));
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
  invalid($t("zzz-zenkov.text_19e38bf0d1"));
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
  const value = count(row.max_rank, $t("zzz-zenkov.text_6570a98f28"), percent ? 10_000 : 999_999_999);
  if (value) return { value, percent };
}

function item(row: Json, icon: string): ZzzZenkovItem {
  return { name: text(row.name, 120), icon: text(row[icon]), rarity: count(row.rarity, $t("zzz-zenkov.text_5309323295"), 99),
    unlocked: flag(row.unlock), count: count(row.number, $t("zzz-zenkov.text_d4848bfff0")), price: money(row.price) };
}

function collection(value: unknown, icon: string): Collection | undefined {
  const row = object(value, $t("zzz-zenkov.text_008e539a00"));
  if (!row) return;
  const entries = list(row.list, $t("zzz-zenkov.text_60a53514eb"));
  return { current: count(row.cur, $t("zzz-zenkov.text_e9cbb10b0e")), total: count(row.total, $t("zzz-zenkov.text_acf9c8dd9c")),
    items: entries.slice(0, 48).map(entry => item(object(entry, $t("zzz-zenkov.text_21558137d9")) ?? invalid($t("zzz-zenkov.text_21558137d9")), icon)),
    hiddenItems: Math.max(0, entries.length - 48) };
}

function time(value: unknown, calendar: true): string | undefined;
function time(value: unknown, calendar: false): number | undefined;
function time(value: unknown, calendar: boolean) {
  const row = object(value, calendar ? $t("zzz-zenkov.text_f4f3c06250") : $t("zzz-zenkov.text_e77e3d58b0"));
  if (!row) return;
  const hours = count(row.hour, $t("zzz-zenkov.text_3b6fefc50f"), calendar ? 23 : 999) ?? 0;
  const minutes = count(row.minute, $t("zzz-zenkov.text_bd957bc497"), 59) ?? 0;
  const seconds = count(row.second, $t("zzz-zenkov.text_9dcdc2b289"), 59) ?? 0;
  if (!calendar) {
    if (row.hour == null && row.minute == null && row.second == null) return;
    return hours * 3600 + minutes * 60 + seconds;
  }
  const year = count(row.year, $t("zzz-zenkov.text_62ef900a8f"), 9999);
  const month = count(row.month, $t("zzz-zenkov.text_1625179bad"), 12);
  const day = count(row.day, $t("zzz-zenkov.text_85217f7aff"), 31);
  if (!year || !month || !day) return;
  if (year < 2024) invalid($t("zzz-zenkov.text_f4f3c06250"));
  const datetime = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
  if (datetime.getUTCMonth() !== month - 1) invalid($t("zzz-zenkov.text_f4f3c06250"));
  return datetime.toISOString().slice(0, 19).replace("T", " ");
}

function avatar(value: unknown): ZzzShiyuPortrait | undefined {
  const row = object(value, $t("zzz-zenkov.text_5aea7d747f"));
  if (!row) return;
  const id = count(row.id, $t("zzz-zenkov.text_df1277905d"), 999_999);
  const icon = text(row.role_square_url);
  const name = text(row.name_mi18n ?? row.name, 96);
  if (!id && !icon && !name) return;
  return { itemId: id ? String(id) : undefined, icon, name, rank: count(row.rank, $t("zzz-zenkov.text_e66da4b1b0"), 99) };
}

function run(value: unknown): ZzzZenkovRun {
  const row = object(value, $t("zzz-zenkov.text_3d6c83fd58")) ?? invalid($t("zzz-zenkov.text_3d6c83fd58"));
  const loot = list(row.item_list, $t("zzz-zenkov.text_a4ccc0a299"));
  const difficulty = text(row.difficult, 32);
  return { map: text(row.map_name, 96), started: time(row.start_time, true), seconds: time(row.challenge_time, false),
    difficulty: difficulty === "Hell" ? $t("zzz-zenkov.text_4aa71c5705") : difficulty === "Hard" ? $t("zzz-zenkov.text_4ea02714a1") :
      difficulty === "Easy" || difficulty === "Normal" ? $t("zzz-zenkov.text_de907d10df") : difficulty,
    success: flag(row.is_success), value: money(row.material_total_value),
    avatars: list(row.avatar_list, $t("zzz-zenkov.text_5e688f58fe")).slice(0, 3).flatMap(entry => avatar(entry) ?? []),
    loot: loot.slice(0, 18).map(entry => item(object(entry, $t("zzz-zenkov.text_a8001a9008")) ?? invalid($t("zzz-zenkov.text_a8001a9008")), "icon_url")),
    hiddenLoot: Math.max(0, loot.length - 18) };
}

export function normalizeZzzZenkov(input: unknown, identity: Identity, kind: ZzzZenkovMode, page?: number): ZzzZenkovSnapshot {
  if (page !== undefined && (kind !== "detail" || !Number.isSafeInteger(page) || page < 1)) {
    throw new HoyoRequestError("invalid-input", $t("zzz-zenkov.text_5cffe43b16"));
  }
  const data = object(input, $t("zzz-zenkov.text_0e8b1c78c5")) ?? invalid($t("zzz-zenkov.text_0e8b1c78c5"));
  for (const key of ["uid", "role_id", "game_uid"]) {
    const value = data[key];
    if (value !== undefined && ((typeof value !== "string" && typeof value !== "number") || String(value) !== identity.uid)) {
      invalid($t("zzz-zenkov.text_5e66ce9fd0"));
    }
  }
  for (const key of ["region", "server"]) {
    if (data[key] !== undefined && data[key] !== identity.region) invalid($t("zzz-zenkov.text_e6dcb75782"));
  }
  if (data.game_biz !== undefined && data.game_biz !== "nap_cn") invalid($t("zzz-zenkov.text_a81ce382a1"));
  const maps = list(data.map_list, $t("zzz-zenkov.text_41ab2e0ecb"));
  const shared = { ...identity, rank: rank(data), hiddenMaps: Math.max(0, maps.length - 24), maps: maps.slice(0, 24).map(entry => {
    const row = object(entry, $t("zzz-zenkov.text_8013070a16")) ?? invalid($t("zzz-zenkov.text_8013070a16"));
    return { name: text(row.map_name, 96), unlocked: flag(row.hell_unlock), evacuation: count(row.leave_percent, $t("zzz-zenkov.text_670575b685"), 10_000),
      price: money(row.max_price), rank: rank(row) };
  }) };
  if (kind === "detail") {
    const records = list(data.record_list, $t("zzz-zenkov.text_3d6c83fd58"));
    const firstPage = page ?? 1;
    const pageCount = Math.max(1, Math.ceil(records.length / zzzZenkovPageSize));
    const start = firstPage <= pageCount ? (firstPage - 1) * zzzZenkovPageSize : records.length;
    const end = start + (page === undefined ? initialPages : 1) * zzzZenkovPageSize;
    return { ...shared, kind, status: shared.maps.length || shared.rank || records.length ? "available" : "empty",
      records: records.slice(start, end).map(run), totalRecords: records.length, pageCount, firstPage };
  }
  const seasonRow = object(data.season_data, $t("zzz-zenkov.text_90fccf7d0c"));
  const seasonUnlocked = flag(data.season_unlock);
  const season = seasonRow && { id: count(seasonRow.cur_season_id, $t("zzz-zenkov.text_8f0fbebec6")), level: count(seasonRow.season_level, $t("zzz-zenkov.text_9815726067")),
    stage: count(seasonRow.season_stage, $t("zzz-zenkov.text_59eb8d03ef")), remaining: count(seasonRow.refresh_time, $t("zzz-zenkov.text_ecf4fa6e6c")),
    quest: progress(seasonRow.season_quest, "quest"), coin: progress(seasonRow.season_coin, "coin") };
  const weeklyRemaining = count(data.refresh_time, $t("zzz-zenkov.text_f9558d1121"));
  const duty = progress(data.abyss_duty, "duty");
  const carryValue = money(data.collect_total_value);
  // 官方概况未提供累计统计时返回空串；保留缺失语义，不将其当作实际零值。
  const zGrade = count(data.big_red_num === "" ? undefined : data.big_red_num, $t("zzz-zenkov.text_c96d1186d3"));
  const millionEvacuations = count(data.millions_evacuations === "" ? undefined : data.millions_evacuations, $t("zzz-zenkov.text_99674095ac"));
  const collected = object(data.collection_data, $t("zzz-zenkov.text_008e539a00"));
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
