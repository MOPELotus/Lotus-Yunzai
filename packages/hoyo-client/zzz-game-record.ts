import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

export interface ZzzGameRecordItem {
  readonly itemId: string;
  readonly name: string;
  readonly icon?: string;
  readonly rarity: "S" | "A" | "B";
  readonly level: number;
  readonly rank: number;
  readonly element?: string;
}

const trackedStats = ["active_days", "avatar_num", "buddy_num", "cur_period_zone_layer_count"] as const;

export interface ZzzGameRecordSnapshot {
  readonly uid: string;
  readonly region: string;
  readonly worldLevel?: string;
  readonly avatar?: string;
  readonly stats: Readonly<Record<typeof trackedStats[number], number | string | undefined>>;
  readonly avatars: readonly ZzzGameRecordItem[];
  readonly buddies: readonly ZzzGameRecordItem[];
}

type Json = Record<string, unknown>;

const elements: Readonly<Record<number, string>> = {
  200: "Physical", 201: "Fire", 202: "Ice", 203: "Electric", 204: "Wind", 205: "Ether", 300: "Lumiflux",
};
const subElements: Readonly<Record<string, string>> = { "200:4": "HonedEdge", "202:1": "Frost", "205:2": "AuricInk" };

function invalid(message = "官方绝区零战绩响应格式无效。"): never {
  throw new HoyoRequestError("response", message);
}

function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Json;
}

function whole(value: unknown) {
  const parsed = typeof value === "string" && /^\d{1,10}$/u.test(value) ? Number(value) : value;
  if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
}

function cleanText(value: unknown, limit: number) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const text = value.trim();
  if (text && Buffer.byteLength(text) <= limit) return text;
}

function verifyIdentity(data: Json, uid: string, region: string) {
  for (const key of ["uid", "role_id", "game_uid"]) {
    const value = data[key];
    if (value !== undefined && value !== uid && !(typeof value === "number" && String(value) === uid)) {
      invalid("官方绝区零战绩的 UID 与当前档案不一致。");
    }
  }
  for (const key of ["server", "region"]) {
    if (data[key] !== undefined && data[key] !== region) invalid("官方绝区零战绩的区服与当前档案不一致。");
  }
  if (data.game_biz !== undefined && data.game_biz !== "nap_cn") invalid("官方绝区零战绩的游戏与当前档案不一致。");
}

function entries(value: unknown, kind: "avatar" | "buddy") {
  if (!Array.isArray(value) || value.length > 128) invalid();
  const seen = new Set<number>();
  return value.map((entry): ZzzGameRecordItem => {
    const item = record(entry);
    const id = whole(item.id);
    const level = whole(item.level);
    const rank = whole(kind === "avatar" ? item.rank : item.star);
    const rarity = item.rarity;
    if (!id || seen.has(id) || level === undefined || level > 999 || rank === undefined || rank > 99 ||
        (rarity !== "S" && rarity !== "A" && rarity !== "B")) invalid("官方绝区零战绩的代理人或邦布记录无效。");
    seen.add(id);
    const base: ZzzGameRecordItem = {
      itemId: String(id),
      name: cleanText(item.name_mi18n ?? item.name, 160) ?? (kind === "avatar" ? `代理人 ${id}` : `邦布 ${id}`),
      level, rank, rarity,
    };
    if (kind === "buddy") return {
      ...base, icon: cleanText(item.bangboo_rectangle_url, 1024) ?? cleanText(item.bangboo_square_url, 1024),
    };
    const element = whole(item.element_type) ?? 0;
    const sub = whole(item.sub_element_type) ?? 0;
    return {
      ...base,
      icon: cleanText(item.square_icon, 1024) ?? cleanText(item.role_square_avatar_url, 1024) ?? cleanText(item.group_icon_path, 1024),
      element: subElements[`${element}:${sub}`] ?? elements[element],
    };
  });
}

// Former battle card reads in ZZZure/ZZZ-Plugin 2057599, dist/apps/card.js.
export async function readZzzGameRecord(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: { readonly signal?: AbortSignal } = {}, verifyProfile?: () => Promise<void>): Promise<ZzzGameRecordSnapshot> {
  const uid = source.role.uid;
  const { data: index, region } = await readCnGameRecord(source, transport, { kind: "zzz-index", signal }, verifyProfile);
  verifyIdentity(index, uid, region);
  if (index.role !== undefined && index.role !== null) verifyIdentity(record(index.role), uid, region);

  const stats = record(index.stats);
  const [activeDays, avatarNum, buddyNum] = trackedStats.slice(0, 3).map((field) => whole(stats[field]));
  if (activeDays === undefined || avatarNum === undefined || buddyNum === undefined) invalid();
  const progress = whole(stats.cur_period_zone_layer_count) ?? cleanText(stats.cur_period_zone_layer_count, 48);
  const { data: avatars } = await readCnGameRecord(source, transport, { kind: "zzz-avatar", signal }, verifyProfile);
  verifyIdentity(avatars, uid, region);
  const avatarEntries = entries(avatars.avatar_list, "avatar");
  const { data: buddies } = await readCnGameRecord(source, transport, { kind: "zzz-buddy", signal }, verifyProfile);
  verifyIdentity(buddies, uid, region);
  return {
    uid, region, worldLevel: cleanText(stats.world_level_name, 96), avatar: cleanText(index.cur_head_icon_url, 1024),
    stats: { active_days: activeDays, avatar_num: avatarNum, buddy_num: buddyNum, cur_period_zone_layer_count: progress },
    avatars: avatarEntries, buddies: entries(buddies.list, "buddy"),
  };
}
