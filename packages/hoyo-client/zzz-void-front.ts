import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";
import type { ZzzShiyuPortrait } from "./zzz-shiyu.ts";

type Json = Record<string, unknown>;
type Identity = { readonly uid: string; readonly region: string; readonly scheduleType: 1 | 2 };

export interface ZzzVoidFrontRound {
  readonly name?: string;
  readonly rating?: "S" | "SP" | "A" | "AP" | "B";
  readonly buffName?: string;
  readonly buffIcon?: string;
  readonly avatars: readonly (ZzzShiyuPortrait | undefined)[];
  readonly buddy?: ZzzShiyuPortrait;
}

export interface ZzzVoidFrontStage extends ZzzVoidFrontRound {
  readonly bossIcon?: string;
  readonly score?: number;
  readonly maxScore?: number;
  readonly ratio?: string;
  readonly clearedAt?: string;
  readonly rounds: readonly ZzzVoidFrontRound[];
}

export interface ZzzVoidFrontSnapshot extends Identity {
  readonly status: "available" | "empty";
  readonly start?: string;
  readonly end?: string;
  readonly totalScore?: number;
  readonly maxScore?: number;
  readonly rank?: number;
  readonly ending?: string;
  readonly endingArtwork?: string;
  readonly finalStage?: ZzzVoidFrontStage;
  readonly stages: readonly ZzzVoidFrontStage[];
}

function invalid(field: string): never {
  throw new HoyoRequestError("response", `官方临界推演响应的${field}无效。`);
}

function object(value: unknown, field: string) {
  if (value == null) return;
  if (typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Json;
}

function count(value: unknown, maximum: number, field: string) {
  if (value == null) return;
  const number = typeof value === "string" && /^\d{1,10}$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0 || number > maximum) invalid(field);
  return number;
}

function text(value: unknown, max = 1024) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const clean = value.trim();
  if (clean && Buffer.byteLength(clean) <= max) return clean;
}

function date(value: unknown) {
  const item = object(value, "时间");
  if (!item) return;
  const year = count(item.year, 2099, "时间年");
  const month = count(item.month, 12, "时间月");
  const day = count(item.day, 31, "时间日");
  if (!year && !month && !day) return;
  const hour = count(item.hour, 23, "时间小时") ?? 0;
  const minute = count(item.minute, 59, "时间分钟") ?? 0;
  const second = count(item.second, 59, "时间秒") ?? 0;
  if (!year || year < 2024 || !month || !day) invalid("时间");
  const result = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (result.getUTCMonth() !== month - 1) invalid("时间");
  return result.toISOString().slice(0, 19).replace("T", " ");
}

function list(value: unknown, max: number, field: string): readonly unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) invalid(field);
  return value;
}

function portrait(value: unknown, buddy: boolean): ZzzShiyuPortrait | undefined {
  const item = object(value, buddy ? "邦布" : "代理人");
  if (!item) return;
  const id = count(item.id, 999_999, "头像编号");
  const icon = text(buddy ? item.bangboo_rectangle_url ?? item.bangboo_square_url : item.role_square_url);
  if (!id && !icon) return;
  const rarity = item.rarity;
  return { itemId: id ? String(id) : undefined, icon, name: text(item.name_mi18n ?? item.name, 96),
    rarity: rarity === "S" || rarity === "A" || rarity === "B" ? rarity : undefined,
    rank: buddy ? undefined : count(item.rank, 99, "代理人影画") };
}

function round(input: Json): ZzzVoidFrontRound {
  const rating = typeof input.star === "string" ? input.star.toUpperCase() : undefined;
  const buff = object(input.buffer, "增益");
  return {
    name: text(input.name, 192), buffName: text(buff?.name, 128), buffIcon: text(buff?.icon),
    rating: rating === "S" || rating === "SP" || rating === "A" || rating === "AP" || rating === "B" ? rating : undefined,
    avatars: list(input.avatar_list, 3, "队伍").map(item => portrait(item, false)), buddy: portrait(input.buddy, true),
  };
}

function stage(input: unknown): ZzzVoidFrontStage {
  const row = object(input, "关卡") ?? invalid("关卡");
  const ratio = row.score_ratio;
  return {
    ...round(row),
    score: count(row.score, 999_999_999, "关卡得分"),
    maxScore: count(row.max_score, 999_999_999, "关卡满分"),
    ratio: typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 ? String(ratio) : text(ratio, 32),
    clearedAt: date(row.challenge_time),
    rounds: list(row.sub_challenge_record, 8, "子关").map(item => round(object(item, "子关") ?? invalid("子关"))),
  };
}

function verifyIdentity(input: Json, identity: Identity) {
  for (const key of ["uid", "role_id", "game_uid"]) {
    const value = input[key];
    if (value !== undefined && ((typeof value !== "string" && typeof value !== "number") || String(value) !== identity.uid)) {
      invalid("档案 UID");
    }
  }
  for (const key of ["region", "server"]) {
    if (input[key] !== undefined && input[key] !== identity.region) invalid("档案区服");
  }
  if (input.game_biz !== undefined && input.game_biz !== "nap_cn") invalid("游戏标识");
  if (input.schedule_type !== undefined && count(input.schedule_type, 2, "期次") !== identity.scheduleType) invalid("期次");
}

export function normalizeZzzVoidFront(input: unknown, identity: Identity): ZzzVoidFrontSnapshot {
  const response = object(input, "格式") ?? invalid("格式");
  verifyIdentity(response, identity);
  const data = object(response.void_front_battle_detail, "详情");
  if (!data) return { ...identity, status: "empty", stages: [] };
  verifyIdentity(data, identity);
  const summary = object(data.void_front_battle_abstract_info_brief, "总览");
  const boss = object(data.boss_challenge_record, "末关");
  const bossInfo = object(boss?.boss_info, "首领");
  const last = boss?.main_challenge_record == null ? undefined : stage(boss.main_challenge_record);
  const finalStage = last && { ...last, name: text(bossInfo?.name, 192) ?? last.name, bossIcon: text(bossInfo?.icon) };
  const stages = list(data.main_challenge_record_list, 8, "关卡列表").map(stage);
  if (!summary && !finalStage && !stages.length) return { ...identity, status: "empty", stages: [] };
  const start = date(summary?.start_time);
  const end = date(summary?.end_time);
  if (start && end && start >= end) invalid("统计周期");
  return {
    ...identity, status: "available", start, end, finalStage, stages,
    totalScore: count(summary?.total_score, 999_999_999, "总得分"),
    maxScore: count(summary?.max_score, 999_999_999, "总满分"),
    rank: count(summary?.rank_percent, 10_000, "排名"),
    ending: text(summary?.ending_record_name, 192),
    endingArtwork: text(summary?.ending_record_bg_pic),
  };
}

// Fixed ZZZure/ZZZ-Plugin 2057599 uses the detail route for both periods.
export async function readZzzVoidFront(source: ProfileRequestContext, transport: HoyoTransport,
  { scheduleType, signal }: { readonly scheduleType: 1 | 2; readonly signal?: AbortSignal },
  verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "zzz-void-front", scheduleType, signal }, verifyProfile);
  return normalizeZzzVoidFront(data, { uid: source.role.uid, region, scheduleType });
}
