import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";
import type { ZzzShiyuPortrait } from "./zzz-shiyu.ts";

type Json = Record<string, unknown>;
type Identity = { readonly uid: string; readonly region: string };

export interface ZzzTowerAvatar extends ZzzShiyuPortrait {
  readonly score?: number;
  readonly percentile?: number;
}

export interface ZzzTowerSeason {
  readonly number: 1 | 2 | 3 | 4;
  readonly layer?: number;
  readonly medal?: string;
  readonly score?: number;
  readonly mvp?: number;
  readonly percentile?: number;
  readonly avatars: readonly ZzzTowerAvatar[];
}

export interface ZzzClimbingTowerSnapshot extends Identity {
  readonly status: "available" | "empty";
  readonly seasons: readonly ZzzTowerSeason[];
}

function invalid(field: string): never {
  throw new HoyoRequestError("response", `官方拟真鏖战试炼响应的${field}无效。`);
}

function object(value: unknown, field: string) {
  if (value == null) return;
  if (typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Json;
}

function count(value: unknown, maximum: number, field: string) {
  if (value == null) return;
  const parsed = typeof value === "string" && /^\d{1,10}$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) invalid(field);
  return parsed;
}

function text(value: unknown, limit = 1024) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const clean = value.trim();
  if (clean && Buffer.byteLength(clean) <= limit) return clean;
}

function avatarList(value: unknown): readonly ZzzTowerAvatar[] {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid("代理人排行");
  return value.slice(0, 3).map(input => {
    const row = object(input, "排行代理人") ?? invalid("排行代理人");
    const id = count(row.avatar_id ?? row.id, 999_999, "代理人编号");
    const rarity = typeof row.rarity === "string" ? row.rarity.toUpperCase() : undefined;
    return { itemId: id ? String(id) : undefined, name: text(row.name, 96), icon: text(row.icon),
      rarity: rarity === "S" || rarity === "A" || rarity === "B" ? rarity : undefined,
      score: count(row.score, 999_999_999, "代理人分数"),
      percentile: count(row.rank_percent, 10_000, "代理人排名") };
  });
}

function verifyIdentity(data: Json, expected: Identity) {
  for (const key of ["uid", "game_uid", "role_id"]) {
    const id = data[key];
    if (id !== undefined && ((typeof id !== "string" && typeof id !== "number") || String(id) !== expected.uid)) {
      invalid("档案 UID");
    }
  }
  for (const key of ["region", "server"]) {
    if (data[key] !== undefined && data[key] !== expected.region) invalid("档案区服");
  }
  if (data.game_biz !== undefined && data.game_biz !== "nap_cn") invalid("游戏标识");
}

export function normalizeZzzClimbingTower(input: unknown, identity: Identity): ZzzClimbingTowerSnapshot {
  const data = object(input, "格式") ?? invalid("格式");
  verifyIdentity(data, identity);
  const seasons: ZzzTowerSeason[] = [];
  for (const number of [1, 2, 3, 4] as const) {
    const branch = object(data[`climbing_tower_s${number}`], `S${number}赛季`);
    if (!branch) continue;
    verifyIdentity(branch, identity);
    const layer = number <= 2 ? branch : object(branch.layer_info, "挑战分数");
    const mvp = number <= 2 ? branch : object(branch.mvp_info, "无伤通关");
    seasons.push({
      number, medal: text(layer?.medal_icon), layer: count(layer?.climbing_tower_layer, 999_999, "层数"),
      score: number >= 3 ? count(layer?.total_score, 999_999_999, "分数") : undefined,
      mvp: number >= 2 ? count(mvp?.floor_mvp_num, 999_999, "无伤通关") : undefined,
      percentile: number >= 3 ? count(mvp?.rank_percent, 10_000, "排名") : undefined,
      avatars: number === 4 ? avatarList(branch.display_avatar_rank_list) : [],
    });
  }
  return { ...identity, status: seasons.length ? "available" : "empty", seasons };
}

// The fixed 2057599 client reads all four seasons through one request without a schedule argument.
export async function readZzzClimbingTower(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: { readonly signal?: AbortSignal }, verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "zzz-climbing-tower", signal }, verifyProfile);
  return normalizeZzzClimbingTower(data, { uid: source.role.uid, region });
}
