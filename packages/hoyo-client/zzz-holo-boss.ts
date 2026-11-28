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

export interface ZzzHoloBossRoom {
  readonly name?: string;
  readonly bossIcon?: string;
  readonly medalIcon?: string;
  readonly undamaged: boolean;
  readonly stars?: number;
  readonly duration?: number;
  readonly rank?: number;
  readonly avatars: readonly (ZzzShiyuPortrait | undefined)[];
}

export interface ZzzHoloBossSnapshot extends Identity {
  readonly status: "available" | "empty";
  readonly period?: { readonly start: string; readonly end: string };
  readonly totalStars?: number;
  readonly totalDuration?: number;
  readonly undamaged: number;
  readonly bosses: readonly ZzzHoloBossRoom[];
}

function invalid(field: string): never {
  throw new HoyoRequestError("response", $t("zzz-holo-boss.text_08256966ea", { "field": field }));
}

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function count(value: unknown, maximum: number) {
  const number = typeof value === "string" && /^\d{1,8}$/u.test(value) ? Number(value) : value;
  if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0 && number <= maximum) return number;
}

function optionalCount(value: unknown, maximum: number, field: string) {
  if (value === undefined || value === null) return;
  return count(value, maximum) ?? invalid(field);
}

function text(value: unknown, limit = 1024) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const cleaned = value.trim();
  if (cleaned && Buffer.byteLength(cleaned) <= limit) return cleaned;
}

function wallTime(value: unknown) {
  if (value === undefined || value === null) return;
  const fields = object(value) ?? invalid($t("zzz-holo-boss.text_f4f09df9e1"));
  const year = count(fields.year, 2099);
  const month = count(fields.month, 12);
  const day = count(fields.day, 31);
  if (year === 0 && month === 0 && day === 0) return;
  const hour = count(fields.hour ?? 0, 23);
  const minute = count(fields.minute ?? 0, 59);
  const second = count(fields.second ?? 0, 59);
  if (!year || year < 2024 || !month || !day || hour === undefined || minute === undefined || second === undefined) invalid($t("zzz-holo-boss.text_f4f09df9e1"));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCMonth() !== month - 1) invalid($t("zzz-holo-boss.text_f4f09df9e1"));
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function duration(value: unknown) {
  if (value === undefined || value === null) return;
  const fields = object(value) ?? invalid($t("zzz-holo-boss.text_c5c66a9f44"));
  if (fields.minute == null && fields.second == null) return;
  const minute = count(fields.minute ?? 0, 999);
  const second = count(fields.second ?? 0, 59);
  if (minute === undefined || second === undefined) invalid($t("zzz-holo-boss.text_c5c66a9f44"));
  return minute * 60 + second;
}

function portrait(value: unknown): ZzzShiyuPortrait | undefined {
  if (value === null) return;
  const row = object(value) ?? invalid($t("zzz-holo-boss.text_5aea7d747f"));
  const id = count(row.id, 999_999);
  const icon = text(row.role_square_url);
  if (!id && !icon) return;
  const rarity = row.rarity;
  return { itemId: id ? String(id) : undefined, icon, name: text(row.name_mi18n ?? row.name, 96),
    rarity: rarity === "S" || rarity === "A" || rarity === "B" ? rarity : undefined, rank: count(row.rank, 99) };
}

function room(input: unknown): ZzzHoloBossRoom {
  const row = object(input) ?? invalid($t("zzz-holo-boss.text_83c1bceb83"));
  const boss = row.boss == null ? undefined : object(row.boss) ?? invalid($t("zzz-holo-boss.text_58cae7ec87"));
  const medal = boss?.medal == null ? undefined : object(boss.medal) ?? invalid($t("zzz-holo-boss.text_d3099bb227"));
  if (medal?.is_no_injured !== undefined && typeof medal.is_no_injured !== "boolean") invalid($t("zzz-holo-boss.text_d8623bb355"));
  const avatars = row.avatar_list ?? [];
  if (!Array.isArray(avatars) || avatars.length > 3) invalid($t("zzz-holo-boss.text_1053fbb75f"));
  const rank = optionalCount(row.rank, 10_000, $t("zzz-holo-boss.text_6570a98f28"));
  return {
    name: text(boss?.name, 192), bossIcon: text(boss?.icon), medalIcon: text(medal?.medal_icon),
    undamaged: medal?.is_no_injured === true,
    stars: optionalCount(row.star, 4, $t("zzz-holo-boss.text_9c55a439d7")), duration: duration(row.challenge_time), rank: rank || undefined,
    avatars: avatars.map(portrait),
  };
}

function total(bosses: readonly ZzzHoloBossRoom[], key: "stars" | "duration") {
  if (bosses.every(boss => boss[key] !== undefined)) return bosses.reduce((sum, boss) => sum + (boss[key] ?? 0), 0);
}

export function normalizeZzzHoloBoss(value: unknown, identity: Identity): ZzzHoloBossSnapshot {
  const data = object(value);
  if (!data || typeof data.unlock !== "boolean") invalid($t("zzz-holo-boss.text_beddbcb9d8"));
  for (const key of ["uid", "role_id", "game_uid"]) {
    const actual = data[key];
    if (actual !== undefined && (typeof actual !== "string" && typeof actual !== "number" || String(actual) !== identity.uid)) {
      invalid($t("zzz-holo-boss.text_5e66ce9fd0"));
    }
  }
  for (const key of ["region", "server"]) {
    if (data[key] !== undefined && data[key] !== identity.region) invalid($t("zzz-holo-boss.text_e6dcb75782"));
  }
  if (data.game_biz !== undefined && data.game_biz !== (identity.region.endsWith("_cn") ? "nap_cn" : "nap_global")) invalid($t("zzz-holo-boss.text_a81ce382a1"));
  if (data.schedule_type !== undefined && count(data.schedule_type, 2) !== identity.scheduleType) invalid($t("zzz-holo-boss.text_4a703a03f5"));
  const rooms = data.list ?? [];
  if (!Array.isArray(rooms) || rooms.length > 8) invalid($t("zzz-holo-boss.text_3ed0782680"));
  if (!data.unlock || !rooms.length) return { ...identity, status: "empty", undamaged: 0, bosses: [] };
  const start = wallTime(data.start_time);
  const end = wallTime(data.end_time);
  if (start && end && start >= end) invalid($t("zzz-holo-boss.text_f4f09df9e1"));
  const bosses = rooms.map(room);
  return {
    ...identity, status: "available", period: start && end ? { start, end } : undefined, bosses,
    totalStars: total(bosses, "stars"), totalDuration: total(bosses, "duration"),
    undamaged: bosses.filter(boss => boss.undamaged).length,
  };
}

// ZZZure/ZZZ-Plugin 2057599 uses holo_boss_detail with schedule_type 1 or 2.
export async function readZzzHoloBoss(source: ProfileRequestContext, transport: HoyoTransport,
  { scheduleType, signal }: { readonly scheduleType: 1 | 2; readonly signal?: AbortSignal },
  verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "zzz-holo-boss", scheduleType, signal }, verifyProfile);
  return normalizeZzzHoloBoss(data, { uid: source.role.uid, region, scheduleType });
}
