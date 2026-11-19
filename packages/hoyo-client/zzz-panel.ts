import { setTimeout as delay } from "node:timers/promises";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

type Json = Record<string, unknown>;

export interface ZzzPanelAvatar {
  readonly id: number;
  readonly name_mi18n: string;
  readonly full_name_mi18n?: string;
  readonly rarity: "S" | "A" | "B";
  readonly rank: number;
  readonly level: number;
  readonly role_square_url?: string;
  readonly group_icon_path?: string;
  readonly [field: string]: unknown;
}

export interface ZzzPanelSnapshot {
  readonly uid: string;
  readonly region: string;
  readonly avatars: readonly ZzzPanelAvatar[];
  readonly missingIds: readonly number[];
}

export interface ZzzPanelOptions {
  readonly ids?: readonly number[];
  readonly roleInterval?: number;
  readonly signal?: AbortSignal;
}

const panelFields = [
  "element_type", "sub_element_type", "camp_name_mi18n", "avatar_profession", "hollow_icon_path", "equip", "weapon",
  "properties", "skills", "ranks", "role_vertical_painting_url", "equip_plan_info", "us_full_name", "vertical_painting_color",
  "skin_list", "skin_id", "awaken_state", "skill_awaken", "is_chosen",
] as const;
const maximumAvatars = 128;

function invalid(message = "官方绝区零面板的角色资料无效。"): never {
  throw new HoyoRequestError("response", message);
}

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function number(value: unknown, limit: number) {
  const parsed = typeof value === "string" && /^\d{1,6}$/u.test(value) ? Number(value) : value;
  if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= limit) return parsed;
}

function clean(value: unknown, limit: number) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const text = value.trim();
  if (text && Buffer.byteLength(text) <= limit) return text;
}

function identity(data: Json, uid: string, region: string) {
  for (const field of ["uid", "role_id", "game_uid"]) {
    const value = data[field];
    if (value !== undefined && value !== uid && (typeof value !== "number" || String(value) !== uid)) {
      invalid("官方绝区零面板的 UID 与当前档案不一致。");
    }
  }
  for (const field of ["server", "region"]) {
    if (data[field] !== undefined && data[field] !== region) invalid("官方绝区零面板的区服与当前档案不一致。");
  }
  if (data.game_biz !== undefined && data.game_biz !== "nap_cn") invalid("官方绝区零面板的游戏与当前档案不一致。");
}

export function normalizeZzzPanelAvatar(input: unknown): ZzzPanelAvatar {
  const data = object(input);
  if (!data) invalid();
  const id = number(data.id, 999_999);
  const rank = number(data.rank, 6);
  const level = number(data.level, 100);
  const name = clean(data.name_mi18n, 160);
  const rarity = data.rarity;
  if (!id || !name || rank === undefined || level === undefined ||
      (rarity !== "S" && rarity !== "A" && rarity !== "B")) invalid();
  return {
    id, name_mi18n: name, full_name_mi18n: clean(data.full_name_mi18n, 192), rarity, rank, level,
    role_square_url: clean(data.role_square_url, 1024), group_icon_path: clean(data.group_icon_path, 1024),
    ...Object.fromEntries(panelFields.flatMap(key => Object.hasOwn(data, key) ? [[key, data[key]]] : [])),
  };
}

function ownedIds(data: Json): number[] {
  const entries = data.avatar_list;
  if (!Array.isArray(entries) || entries.length > maximumAvatars) invalid();
  const ids = entries.map(row => {
    const id = number(object(row)?.id, 999_999);
    if (!id) invalid();
    return id;
  });
  if (new Set(ids).size !== ids.length) invalid("官方绝区零面板的角色列表包含重复角色。");
  return ids;
}

function explicitIds(ids: readonly number[]) {
  if (!Array.isArray(ids) || !ids.length || ids.length > maximumAvatars || ids.some(id => typeof id !== "number" || !number(id, 999_999))) {
    throw new HoyoRequestError("invalid-input", "绝区零面板的角色编号无效。");
  }
  return [...new Set(ids)];
}

// ZZZure/ZZZ-Plugin 2057599 dist/lib/avatar.js queries the owned roster, then one avatar at a time.
export async function readZzzPanel(source: ProfileRequestContext, transport: HoyoTransport,
  { ids, roleInterval = 3000, signal }: ZzzPanelOptions = {}, verifyProfile?: () => Promise<void>): Promise<ZzzPanelSnapshot> {
  if (!Number.isSafeInteger(roleInterval) || roleInterval < 0 || roleInterval > 2_147_483_647) {
    throw new HoyoRequestError("invalid-input", "绝区零面板的角色刷新间隔无效。");
  }
  const uid = source.role.uid;
  let region = source.role.region;
  let targets: number[];
  if (ids) targets = explicitIds(ids);
  else {
    const base = await readCnGameRecord(source, transport, { kind: "zzz-avatar", signal }, verifyProfile);
    region = base.region;
    identity(base.data, uid, region);
    targets = ownedIds(base.data);
  }
  const missingIds: number[] = [];
  const avatars: ZzzPanelAvatar[] = [];
  for (const [index, characterId] of targets.entries()) {
    if (index) await delay(Math.max(100, roleInterval), undefined, { signal });
    const detail = await readCnGameRecord(source, transport, { kind: "zzz-panel-detail", characterId, signal }, verifyProfile);
    region = detail.region;
    identity(detail.data, uid, region);
    const list = detail.data.avatar_list;
    if (!Array.isArray(list) || list.length > 1) invalid();
    if (!list.length) { missingIds.push(characterId); continue; }
    const avatar = normalizeZzzPanelAvatar(list[0]);
    if (avatar.id !== characterId) invalid("官方绝区零面板回包的角色与所选角色不一致。");
    avatars.push(avatar);
  }
  return { uid, region, avatars, missingIds };
}
