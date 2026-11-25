import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import { normalizeProfileRoleArtworkUrl, type ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { GameRecordRequestError } from "./game-record.ts";
import { requestStarRailCalculator } from "./genshin-backpack.ts";
import { readStarRailPanel } from "./starrail-panel.ts";

type Json = Record<string, unknown>;
export const defaultStarRailGrowthLevels = [80, 80, 6, 10, 10, 10] as const;

export interface StarRailGrowthOptions {
  readonly avatarId: number;
  readonly name: string;
  readonly levels: readonly number[];
  readonly signal?: AbortSignal;
}
export interface GrowthItem {
  readonly id: number;
  readonly name: string;
  readonly current: number;
  readonly target: number;
  readonly icon?: string;
  readonly rarity?: number;
}
export interface GrowthSkill extends GrowthItem {
  readonly max: number;
}
export interface GrowthMaterial {
  readonly name: string;
  readonly total: number;
  readonly icon?: string;
}
const materialSections = ["avatar_consume", "skill_consume", "equipment_consume"] as const;
export interface StarRailGrowthSnapshot {
  readonly uid: string;
  readonly owned: boolean;
  readonly rank?: number;
  readonly avatar: GrowthItem;
  readonly equipment?: GrowthItem;
  readonly skills: readonly GrowthSkill[];
  readonly materials: Readonly<Record<(typeof materialSections)[number], readonly GrowthMaterial[]>>;
}

const mainSkills = { Point01: $t("starrail-growth.text_d90c73f75a"), Point02: $t("starrail-growth.text_6d8c868f52"), Point03: $t("starrail-growth.text_a985bc32b7"), Point04: $t("starrail-growth.text_866e2e6d67") } as const;
type MainSkill = keyof typeof mainSkills;
const mainAnchors = Object.keys(mainSkills) as MainSkill[];

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function whole(value: unknown, min: number, max: number) {
  const n = typeof value === "string" && /^\d{1,14}$/u.test(value) ? Number(value) : value;
  if (typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max) return n;
}

function label(value: unknown) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const clean = value.trim();
  if (clean && Array.from(clean).length <= 128) return clean;
}

function invalid(message = $t("starrail-growth.text_850933abee")): never {
  throw new HoyoRequestError("response", message);
}

function verifyIdentity(data: Json, uid: string, region: string) {
  const role = object(data.role);
  for (const identity of role ? [data, role] : [data]) {
    if (["uid", "role_id", "game_uid"].some(key => Object.hasOwn(identity, key) && String(identity[key]) !== uid) ||
        ["region", "server"].some(key => Object.hasOwn(identity, key) && identity[key] !== region) ||
        (Object.hasOwn(identity, "game_biz") && identity.game_biz !== "hkrpg_cn")) {
      invalid($t("starrail-growth.text_975639da14"));
    }
  }
}

function targetItem(item: GrowthItem) {
  return { item_id: item.id, cur_level: item.current, target_level: item.target };
}

function decodeSkills(value: unknown, targets: readonly number[]) {
  if (!Array.isArray(value) || value.length < mainAnchors.length || value.length > 96) invalid();
  const ids = new Set<number>();
  const primary = new Map<MainSkill, GrowthSkill>();
  const all = value.map(raw => {
    const skill = object(raw);
    const id = whole(skill?.point_id, 1, 999_999_999);
    const current = whole(skill?.cur_level, 0, 100);
    const max = whole(skill?.max_level, 1, 100);
    if (!id || ids.has(id) || current === undefined || max === undefined) invalid();
    ids.add(id);
    const key = skill?.anchor as MainSkill;
    const ordinal = mainAnchors.indexOf(key);
    const base = ordinal !== -1 && max > 1;
    const requested = base ? targets[ordinal]! : whole(skill?.target_level, 0, max) ?? current;
    const result = { id, current, max, target: Math.max(current, Math.min(max, requested)),
      name: base ? mainSkills[key] : label(skill?.item_name) ?? $t("starrail-growth.text_1695f4e124"), icon: normalizeProfileRoleArtworkUrl(skill?.item_url) };
    if (base) {
      if (primary.has(key)) invalid();
      primary.set(key, result);
    }
    return result;
  });
  if (primary.size !== mainAnchors.length) invalid($t("starrail-growth.text_0f79801a1e"));
  return { all, primary: mainAnchors.map(key => primary.get(key)!) };
}

function materials(data: Json) {
  if (!materialSections.some(key => Object.hasOwn(data, key))) invalid();
  function section(key: typeof materialSections[number]) {
    const rows = data[key];
    if (rows == null) return [];
    if (!Array.isArray(rows) || rows.length > 128) invalid();
    return rows.map((value): GrowthMaterial => {
      const item = object(value);
      const name = label(item?.item_name);
      const total = whole(item?.num, 0, 999_999_999_999);
      if (!name || total === undefined) invalid();
      return { name, total, icon: normalizeProfileRoleArtworkUrl(item?.item_url) };
    });
  }
  return { avatar_consume: section("avatar_consume"), skill_consume: section("skill_consume"), equipment_consume: section("equipment_consume") };
}

// The fixed Genshin 0290a17 route uses the person's roster only to select TabOwned or TabAll.
export async function readStarRailGrowth(source: ProfileRequestContext, transport: HoyoTransport,
  { avatarId, name, levels, signal }: StarRailGrowthOptions, verifyProfile?: () => Promise<void>): Promise<StarRailGrowthSnapshot> {
  const { uid, region, gameBiz } = source.role;
  if (source.game !== "sr" || gameBiz !== "hkrpg_cn" || !/^[1-5]\d{8}$/u.test(uid) ||
      region !== (uid.startsWith("5") ? "prod_qd_cn" : "prod_gf_cn")) {
    throw new HoyoRequestError("invalid-input", $t("starrail-growth.text_85f903a038"));
  }
  if (!source.device.id?.trim()) {
    throw new HoyoRequestError("invalid-input", $t("starrail-growth.text_bb975c66db"));
  }
  if (!whole(avatarId, 1, 9_999_999) || !label(name) || !Array.isArray(levels) ||
      levels.length !== defaultStarRailGrowthLevels.length || levels.some((value, index) =>
        typeof value !== "number" || whole(value, 1, defaultStarRailGrowthLevels[index]!) === undefined)) {
    throw new HoyoRequestError("invalid-input", $t("starrail-growth.text_2d96229fd3"));
  }
  const { avatars } = await readStarRailPanel(source, transport, { signal }, verifyProfile);
  const matches = avatars.filter(candidate => whole(candidate.id, 1, 9_999_999) === avatarId);
  if (matches.length > 1) invalid();
  const ownedAvatar = matches[0];
  const owned = ownedAvatar !== undefined;
  const detailParameters = new URLSearchParams({ game: "hkrpg", lang: "zh-cn", item_id: String(avatarId),
    tab_from: owned ? "TabOwned" : "TabAll", change_target_level: "0", uid, region });
  const detail = await requestStarRailCalculator(source, transport, "avatar/detail", { query: detailParameters, signal, verifyProfile });
  verifyIdentity(detail, uid, region);
  if (owned && detail.is_login === false) throw new GameRecordRequestError($t("starrail-growth.text_2957fe507f"), "expired", "api", 200);
  const displayed = object(detail.avatar);
  if ((!owned && !displayed) ||
      ["id", "item_id", "avatar_id"].some(key => displayed && Object.hasOwn(displayed, key) &&
        whole(displayed[key], 1, 9_999_999) !== avatarId)) invalid();
  const current = owned ? whole(ownedAvatar.level, 1, 80) : 1;
  if (current === undefined) invalid();
  const avatar = { id: avatarId, name: label(ownedAvatar?.name ?? displayed?.name ?? displayed?.item_name) ?? name,
    rarity: whole(ownedAvatar?.rarity ?? displayed?.rarity, 1, 5), current, target: Math.max(current, levels[0]!),
    icon: normalizeProfileRoleArtworkUrl(ownedAvatar?.icon ?? displayed?.icon_url ?? displayed?.item_url) };
  const rank = owned ? whole(ownedAvatar.rank, 0, 6) : undefined;
  const equip = object(ownedAvatar?.equip);
  const equipmentId = whole(equip?.id, 1, 9_999_999);
  let equipment: GrowthItem | undefined;
  if (equipmentId) {
    const level = whole(equip?.level, 1, 80);
    if (level === undefined) invalid();
    equipment = { id: equipmentId, name: label(equip?.name) ?? $t("starrail-growth.text_4f052158b1"), current: level, target: Math.max(level, levels[1]!),
      rarity: whole(equip?.rarity, 1, 5), icon: normalizeProfileRoleArtworkUrl(equip?.icon) };
  }
  const { all, primary } = decodeSkills(detail.skill_list ?? detail.skills, levels.slice(2));
  const body = JSON.stringify({ game: "hkrpg", avatar: targetItem(avatar), skill_list: all.map(targetItem),
    ...(equipment && { equipment: targetItem(equipment) }) });
  const computed = await requestStarRailCalculator(source, transport, "compute", {
    query: new URLSearchParams({ game: "hkrpg" }), body, signal, verifyProfile,
  });
  verifyIdentity(computed, uid, region);
  return { uid, owned, rank, avatar, equipment, skills: primary, materials: materials(computed) };
}
