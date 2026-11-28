import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
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
  readonly rankEndsAt?: number;
  readonly endingUnlocked?: boolean;
  readonly totalScore?: number;
  readonly maxScore?: number;
  readonly rank?: number;
  readonly ending?: string;
  readonly endingArtwork?: string;
  readonly finalStage?: ZzzVoidFrontStage;
  readonly stages: readonly ZzzVoidFrontStage[];
}

function invalid(field: string): never {
  throw new HoyoRequestError("response", $t("zzz-void-front.text_669109f62a", { "field": field }));
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

function rankingDeadline(value: unknown) {
  const seconds = typeof value === "string" && /^\d{1,10}$/u.test(value) ? Number(value) : value;
  if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 4_102_444_800) {
    return seconds * 1000;
  }
}

function text(value: unknown, max = 1024) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const clean = value.trim();
  if (clean && Buffer.byteLength(clean) <= max) return clean;
}

function date(value: unknown) {
  const item = object(value, $t("zzz-void-front.text_8b6ff49851"));
  if (!item) return;
  const year = count(item.year, 2099, $t("zzz-void-front.text_09689712df"));
  const month = count(item.month, 12, $t("zzz-void-front.text_c2fef1e66d"));
  const day = count(item.day, 31, $t("zzz-void-front.text_5757c0470a"));
  if (!year && !month && !day) return;
  const hour = count(item.hour, 23, $t("zzz-void-front.text_0481b2f6e8")) ?? 0;
  const minute = count(item.minute, 59, $t("zzz-void-front.text_f92d097331")) ?? 0;
  const second = count(item.second, 59, $t("zzz-void-front.text_2103bde828")) ?? 0;
  if (!year || year < 2024 || !month || !day) invalid($t("zzz-void-front.text_8b6ff49851"));
  const result = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (result.getUTCMonth() !== month - 1) invalid($t("zzz-void-front.text_8b6ff49851"));
  return result.toISOString().slice(0, 19).replace("T", " ");
}

function list(value: unknown, max: number, field: string): readonly unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) invalid(field);
  return value;
}

function portrait(value: unknown, buddy: boolean): ZzzShiyuPortrait | undefined {
  const item = object(value, buddy ? $t("zzz-void-front.text_aa46a7c35b") : $t("zzz-void-front.text_5aea7d747f"));
  if (!item) return;
  const id = count(item.id, 999_999, $t("zzz-void-front.text_18fc58c624"));
  const icon = text(buddy ? item.bangboo_rectangle_url ?? item.bangboo_square_url : item.role_square_url);
  if (!id && !icon) return;
  const rarity = item.rarity;
  return { itemId: id ? String(id) : undefined, icon, name: text(item.name_mi18n ?? item.name, 96),
    rarity: rarity === "S" || rarity === "A" || rarity === "B" ? rarity : undefined,
    rank: buddy ? undefined : count(item.rank, 99, $t("zzz-void-front.text_18537a49b5")) };
}

function round(input: Json): ZzzVoidFrontRound {
  const rating = typeof input.star === "string" ? input.star.toUpperCase().replace("+", "P") : undefined;
  const buff = object(input.buffer, $t("zzz-void-front.text_76d70b2006"));
  return {
    name: text(input.name, 192), buffName: text(buff?.name, 128), buffIcon: text(buff?.icon),
    rating: rating === "S" || rating === "SP" || rating === "A" || rating === "AP" || rating === "B" ? rating : undefined,
    avatars: list(input.avatar_list, 3, $t("zzz-void-front.text_1053fbb75f")).map(item => portrait(item, false)), buddy: portrait(input.buddy, true),
  };
}

function stage(input: unknown): ZzzVoidFrontStage {
  const row = object(input, $t("zzz-void-front.text_ff534801b8")) ?? invalid($t("zzz-void-front.text_ff534801b8"));
  const ratio = row.score_ratio;
  return {
    ...round(row),
    score: count(row.score, 999_999_999, $t("zzz-void-front.text_106ea4a80e")),
    maxScore: count(row.max_score, 999_999_999, $t("zzz-void-front.text_98911a8894")),
    ratio: typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 ? String(ratio) : text(ratio, 32),
    clearedAt: date(row.challenge_time),
    rounds: list(row.sub_challenge_record, 8, $t("zzz-void-front.text_089bce08ee")).map(item => round(object(item, $t("zzz-void-front.text_089bce08ee")) ?? invalid($t("zzz-void-front.text_089bce08ee")))),
  };
}

function verifyIdentity(input: Json, identity: Identity) {
  for (const key of ["uid", "role_id", "game_uid"]) {
    const value = input[key];
    if (value !== undefined && ((typeof value !== "string" && typeof value !== "number") || String(value) !== identity.uid)) {
      invalid($t("zzz-void-front.text_5e66ce9fd0"));
    }
  }
  for (const key of ["region", "server"]) {
    if (input[key] !== undefined && input[key] !== identity.region) invalid($t("zzz-void-front.text_e6dcb75782"));
  }
  if (input.game_biz !== undefined && input.game_biz !== (identity.region.endsWith("_cn") ? "nap_cn" : "nap_global")) invalid($t("zzz-void-front.text_a81ce382a1"));
  if (input.schedule_type !== undefined && count(input.schedule_type, 2, $t("zzz-void-front.text_4a703a03f5")) !== identity.scheduleType) invalid($t("zzz-void-front.text_4a703a03f5"));
}

export function normalizeZzzVoidFront(input: unknown, identity: Identity): ZzzVoidFrontSnapshot {
  const response = object(input, $t("zzz-void-front.text_0e8b1c78c5")) ?? invalid($t("zzz-void-front.text_0e8b1c78c5"));
  verifyIdentity(response, identity);
  const data = object(response.void_front_battle_detail, $t("zzz-void-front.text_979a332955"));
  if (!data) return { ...identity, status: "empty", stages: [] };
  verifyIdentity(data, identity);
  const summary = object(data.void_front_battle_abstract_info_brief, $t("zzz-void-front.text_a33db57305"));
  const boss = object(data.boss_challenge_record, $t("zzz-void-front.text_52824cd001"));
  const bossInfo = object(boss?.boss_info, $t("zzz-void-front.text_58cae7ec87"));
  const last = boss?.main_challenge_record == null ? undefined : stage(boss.main_challenge_record);
  const finalStage = last && { ...last, name: text(bossInfo?.name, 192) ?? last.name, bossIcon: text(bossInfo?.icon) };
  const stages = list(data.main_challenge_record_list, 8, $t("zzz-void-front.text_3004d3e234")).map(stage);
  if (!summary && !finalStage && !stages.length) return { ...identity, status: "empty", stages: [] };
  const start = date(summary?.start_time);
  const end = date(summary?.end_time);
  if (start && end && start >= end) invalid($t("zzz-void-front.text_f4f09df9e1"));
  const rankEndsAt = rankingDeadline(summary?.end_ts);
  const endingUnlocked = typeof summary?.has_ending_record === "boolean" ? summary.has_ending_record : undefined;
  return {
    ...identity, status: "available", start, end, finalStage, stages, rankEndsAt, endingUnlocked,
    totalScore: count(summary?.total_score, 999_999_999, $t("zzz-void-front.text_18c6ed8a22")),
    maxScore: count(summary?.max_score, 999_999_999, $t("zzz-void-front.text_cdd34874b1")),
    rank: count(summary?.rank_percent, 10_000, $t("zzz-void-front.text_6570a98f28")),
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
