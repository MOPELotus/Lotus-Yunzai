import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import { normalizeGameRoles, type ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";
import { openHoYoLabZzzRecordTransport, type HoYoLabCheckinAccount, type HoYoLabCheckinOptions } from "./hoyolab-checkin-transport.ts";
import { resolveZzzGachaLinkRole } from "./zzz-gacha-link.ts";

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

export interface ZzzOwnedBuddyRoster {
  readonly uid: string;
  readonly region: string;
  readonly buddies: readonly ZzzGameRecordItem[];
}

export interface ZzzGameRecordSnapshot extends ZzzOwnedBuddyRoster {
  readonly worldLevel?: string;
  readonly avatar?: string;
  readonly stats: Readonly<Record<typeof trackedStats[number], number | string | undefined>>;
  readonly avatars: readonly ZzzGameRecordItem[];
}

type Json = Record<string, unknown>;

const elements: Readonly<Record<number, string>> = {
  200: "Physical", 201: "Fire", 202: "Ice", 203: "Electric", 204: "Wind", 205: "Ether", 300: "Lumiflux",
};
const subElements: Readonly<Record<string, string>> = { "200:4": "HonedEdge", "202:1": "Frost", "205:2": "AuricInk" };

function invalid(message = $t("zzz-game-record.text_82d9a22b81")): never {
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

function verifyIdentity(data: Json, uid: string, region: string, gameBiz: string) {
  for (const key of ["uid", "role_id", "game_uid"]) {
    const value = data[key];
    if (value !== undefined && value !== uid && !(typeof value === "number" && String(value) === uid)) {
      invalid($t("zzz-game-record.text_76560c2f3d"));
    }
  }
  for (const key of ["server", "region"]) {
    if (data[key] !== undefined && data[key] !== region) invalid($t("zzz-game-record.text_9bc390a796"));
  }
  if (data.game_biz !== undefined && data.game_biz !== gameBiz) invalid($t("zzz-game-record.text_62c41035d3"));
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
        (rarity !== "S" && rarity !== "A" && rarity !== "B")) invalid($t("zzz-game-record.text_7ed2e4e53e"));
    seen.add(id);
    const base: ZzzGameRecordItem = {
      itemId: String(id),
      name: cleanText(item.name_mi18n ?? item.name, 160) ?? (kind === "avatar" ? $t("zzz-game-record.text_725c93487b", { "id": id }) : $t("zzz-game-record.text_0c382eb58a", { "id": id })),
      level, rank, rarity,
    };
    if (kind === "buddy") return {
      ...base, icon: cleanText(item.bangboo_rectangle_url, 1024) ?? cleanText(item.bangboo_square_url, 1024),
    };
    const element = whole(item.element_type) ?? 0;
    const sub = whole(item.sub_element_type) ?? 0;
    return {
      ...base,
      icon: cleanText(item.square_icon, 1024) ?? cleanText(item.role_square_avatar_url, 1024) ?? cleanText(item.role_square_url, 1024),
      element: subElements[`${element}:${sub}`] ?? elements[element],
    };
  });
}

// Former battle card reads in ZZZure/ZZZ-Plugin 2057599, dist/apps/card.js.
export async function readZzzGameRecord(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: { readonly signal?: AbortSignal } = {}, verifyProfile?: () => Promise<void>): Promise<ZzzGameRecordSnapshot> {
  const { data: index, region } = await readCnGameRecord(source, transport, { kind: "zzz-index", signal }, verifyProfile);
  const { uid } = source.role;
  verifyRecordRole(index, uid, region, source.role.gameBiz || "nap_cn");
  return readRecord(uid, region, index, async part => {
    const kind = part === "avatar" ? "zzz-avatar" : "zzz-buddy";
    const { data } = await readCnGameRecord(source, transport, { kind, signal }, verifyProfile);
    verifyRecordRole(data, uid, region, source.role.gameBiz || "nap_cn");
    return data;
  });
}

export async function readZzzOwnedBuddyRoster(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: { readonly signal?: AbortSignal } = {}, verifyProfile?: () => Promise<void>): Promise<ZzzOwnedBuddyRoster> {
  const { uid } = source.role;
  const { data, region } = await readCnGameRecord(source, transport, { kind: "zzz-owned-buddy", signal }, verifyProfile);
  verifyRecordRole(data, uid, region, source.role.gameBiz || "nap_cn");
  return { uid, region, buddies: entries(data.list, "buddy") };
}

export interface HoYoLabZzzRecordAccount extends HoYoLabCheckinAccount {
  readonly selectedUid: string;
  readonly revision: string;
}

export async function openHoYoLabZzzOwnedRecord(
  source: HoYoLabZzzRecordAccount, transport: HoyoTransport, options: HoYoLabCheckinOptions,
) {
  const selectionError = () => new HoyoRequestError("invalid-input", $t("zzz-game-record.text_0520c692fd"));
  if (source.selectedUid && !/^[1-9]\d{9}$/u.test(source.selectedUid)) throw selectionError();
  const client = openHoYoLabZzzRecordTransport(source, transport, options);
  const catalogue = (await client.roleList()).map(record);
  const hasUid = (row: Json, uid: string) => row.game_uid === uid ||
    (typeof row.game_uid === "number" && String(row.game_uid) === uid);
  const candidates = catalogue.filter(row => source.selectedUid
    ? hasUid(row, source.selectedUid)
    : catalogue.length === 1 || row.is_chosen === true);
  if (candidates.length !== 1) throw selectionError();
  const entry = candidates[0]!;
  const [role] = normalizeGameRoles([{ ...entry, uid: entry.game_uid, game_biz: entry.game_biz ?? "nap_global" }]);
  if (!role || !role.region || role.gameBiz !== "nap_global" || !/^[1-9]\d{9}$/u.test(role.uid)) throw selectionError();
  if (!source.selectedUid && catalogue.filter(row => hasUid(row, role.uid)).length !== 1) throw selectionError();
  const { uid, region, gameBiz } = resolveZzzGachaLinkRole(role);
  verifyIdentity(entry, uid, region, gameBiz);
  return {
    role,
    async read(part: Parameters<typeof client.read>[0]) {
      const data = await client.read(part, uid, region);
      verifyRecordRole(data, uid, region, gameBiz);
      return data;
    },
    async readMonthly(month: string) {
      const data = await client.readMonthly(uid, region, month);
      verifyRecordRole(data, uid, region, gameBiz);
      return data;
    },
  };
}

export async function readHoYoLabZzzGameRecord(
  source: HoYoLabZzzRecordAccount, transport: HoyoTransport, options: HoYoLabCheckinOptions,
) {
  const { role, read } = await openHoYoLabZzzOwnedRecord(source, transport, options);
  const data = await readRecord(role.uid, role.region, await read("index"), read);
  return { ...data, revision: source.revision, role };
}

function verifyRecordRole(data: Json, uid: string, region: string, gameBiz: string) {
  verifyIdentity(data, uid, region, gameBiz);
  if (data.role !== undefined && data.role !== null) verifyIdentity(record(data.role), uid, region, gameBiz);
}

async function readRecord(uid: string, region: string, index: Json,
  read: (part: "avatar" | "buddy") => Promise<Json>): Promise<ZzzGameRecordSnapshot> {
  const stats = record(index.stats);
  const [activeDays, avatarNum, buddyNum] = trackedStats.slice(0, 3).map((field) => whole(stats[field]));
  if (activeDays === undefined || avatarNum === undefined || buddyNum === undefined) invalid();
  const progress = whole(stats.cur_period_zone_layer_count) ?? cleanText(stats.cur_period_zone_layer_count, 48);
  const avatars = await read("avatar");
  const avatarEntries = entries(avatars.avatar_list, "avatar");
  const buddies = await read("buddy");
  return {
    uid, region, worldLevel: cleanText(stats.world_level_name, 96), avatar: cleanText(index.cur_head_icon_url, 1024),
    stats: { active_days: activeDays, avatar_num: avatarNum, buddy_num: buddyNum, cur_period_zone_layer_count: progress },
    avatars: avatarEntries, buddies: entries(buddies.list, "buddy"),
  };
}
