import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";
import type { ZzzShiyuPortrait } from "./zzz-shiyu.ts";

type Json = Record<string, unknown>;
type Identity = { readonly uid: string; readonly region: string };
export type ZzzHollowMode = "withered" | "lost";

export interface ZzzHollowProgress {
  readonly current?: number;
  readonly maximum?: number;
  readonly icon?: string;
}

export interface ZzzHollowChallenge {
  readonly name?: string;
  readonly heat?: number;
  readonly count?: number;
  readonly seconds?: number;
}

export interface ZzzHollowFighter extends ZzzShiyuPortrait {
  readonly level?: number;
  readonly damageRate?: string;
}

type Result = Identity & { readonly status: "available" | "empty"; readonly collection: readonly ZzzHollowProgress[];
  readonly license?: ZzzHollowProgress };

export type ZzzHollowSnapshot = Result & (
  { readonly hollowMode: "withered"; readonly talent?: ZzzHollowProgress; readonly maxDamage?: number;
    readonly throne?: { readonly seconds?: number; readonly damage?: number;
      readonly avatars: readonly (ZzzHollowFighter | undefined)[]; readonly buddy?: ZzzHollowFighter } } |
  { readonly hollowMode: "lost"; readonly duty?: ZzzHollowProgress; readonly task?: ZzzHollowProgress;
    readonly matrix?: ZzzHollowChallenge; readonly taskForce?: ZzzHollowChallenge;
    readonly specialMission?: ZzzHollowChallenge }
);

function invalid(field: string): never {
  throw new HoyoRequestError("response", `官方零号空洞响应的${field}无效。`);
}

function object(value: unknown, field: string) {
  if (value == null) return;
  if (typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Json;
}

function count(value: unknown, field: string) {
  if (value == null) return;
  const parsed = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) invalid(field);
  return parsed;
}

function text(value: unknown, limit = 1024) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  const clean = value.trim();
  if (clean && Buffer.byteLength(clean) <= limit) return clean;
}

function progress(value: unknown, suffix: string): ZzzHollowProgress | undefined {
  const data = object(value, suffix);
  if (data) return { current: count(data[`cur_${suffix}`], suffix), maximum: count(data[`max_${suffix}`], suffix),
    icon: text(data.icon) };
}

function challenge(value: unknown): ZzzHollowChallenge | undefined {
  const data = object(value, "最优挑战");
  if (data) return { name: text(data.max_name, 192), heat: count(data.heat_count, "以太活性"),
    count: count(data.max_count, "通关次数"), seconds: count(data.best_time, "耗时") };
}

function fighter(value: unknown, buddy: boolean): ZzzHollowFighter | undefined {
  const data = object(value, buddy ? "邦布" : "代理人");
  if (!data) return;
  const id = count(data.id, "阵容编号");
  const icon = text(buddy ? data.bangboo_rectangle_url : data.role_square_url);
  const name = text(data.name_mi18n ?? data.name, 96);
  if (!id && !icon && !name) return;
  const rarity = data.rarity;
  const ratio = data.damage_rate;
  const damageRate = typeof ratio === "number" && Number.isFinite(ratio) ? String(ratio) : text(ratio, 24)?.replace(/%$/u, "");
  return { itemId: id ? String(id) : undefined, icon, name,
    rarity: rarity === "S" || rarity === "A" || rarity === "B" ? rarity : undefined,
    rank: buddy ? undefined : count(data.rank, "影画等级"), level: count(data.level, "阵容等级"),
    damageRate: damageRate && /^\d{1,3}(?:\.\d{1,8})?$/u.test(damageRate) && Number(damageRate) <= 100 ? damageRate : undefined };
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

function optionalList(value: unknown, name: string) {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid(name);
  return value as readonly unknown[];
}

export function normalizeZzzHollowZero(input: unknown, detail: unknown, identity: Identity, hollowMode: ZzzHollowMode): ZzzHollowSnapshot {
  const data = object(input, "摘要") ?? invalid("摘要");
  verifyIdentity(data, identity);
  const collection = optionalList(data.abyss_collect, "收集列表")
    .slice(0, hollowMode === "withered" ? 5 : 7).map(row => progress(row, "collect") ?? {});
  const license = progress(data.abyss_level, "level");
  if (hollowMode === "withered") {
    const supplemental = object(detail, "挑战详情");
    if (supplemental) verifyIdentity(supplemental, identity);
    const max = object(supplemental?.abyss_throne_max, "刀耕火焚");
    const throne = max && { seconds: count(max.time, "探索耗时"), damage: count(max.max_damage, "最高伤害"),
      avatars: optionalList(max.avatar_list, "代理人队伍").slice(0, 3).map(row => fighter(row, false)),
      buddy: fighter(optionalList(max.buddy_list, "邦布队伍")[0], true) };
    const maxDamage = count(object(data.abyss_throne, "挑战摘要")?.max_damage, "最高伤害");
    const talent = progress(data.abyss_talent, "talent");
    return { ...identity, hollowMode, collection, license, talent, maxDamage, throne,
      status: license || talent || collection.length || maxDamage !== undefined || throne ? "available" : "empty" };
  }
  const duty = progress(data.abyss_duty, "duty");
  const task = progress(data.abyss_task, "task");
  const matrix = challenge(data.abyss_max);
  const taskForce = challenge(data.abyss_task_force_investigation_max);
  const specialMission = challenge(data.special_mission);
  return { ...identity, hollowMode, collection, license, duty, task, matrix, taskForce, specialMission,
    status: license || duty || task || collection.length || matrix || taskForce || specialMission ? "available" : "empty" };
}

export async function readZzzHollowZero(source: ProfileRequestContext, transport: HoyoTransport,
  { hollowMode, signal }: { readonly hollowMode: ZzzHollowMode; readonly signal?: AbortSignal },
  verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport, {
    kind: hollowMode === "withered" ? "zzz-hollow-abstract" : "zzz-hollow-lost", signal,
  }, verifyProfile);
  const identity = { uid: source.role.uid, region };
  const summary = normalizeZzzHollowZero(data, undefined, identity, hollowMode);
  if (summary.hollowMode !== "withered" || !summary.maxDamage) return summary;
  const detail = await readCnGameRecord(source, transport, { kind: "zzz-hollow-detail", signal }, verifyProfile);
  return normalizeZzzHollowZero(data, detail.data, identity, hollowMode);
}
