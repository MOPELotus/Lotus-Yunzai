import { genshinResponseRegion } from "./genshin-response-region.ts";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

export interface GenshinWorldBossRow {
  readonly name: string;
  readonly killCount: number;
}

export interface GenshinWorldBossGroup {
  readonly name: string;
  readonly bosses: readonly GenshinWorldBossRow[];
}

export interface GenshinWorldBossSnapshot {
  readonly uid: string;
  readonly region: string;
  readonly status: "available" | "unavailable";
  readonly groups: readonly GenshinWorldBossGroup[];
}

type Json = Record<string, unknown>;
const maxGroups = 128;
const maxBosses = 2048;

function invalid(message: string): never {
  throw new HoyoRequestError("response", message);
}

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function nameOf(value: unknown): string {
  if (typeof value !== "string" || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) {
    invalid("原神世界 BOSS 响应的区域或敌人名称无效。");
  }
  const name = value.trim();
  if (!name || Buffer.byteLength(name) > 256) invalid("原神世界 BOSS 响应的区域或敌人名称无效。");
  return name;
}

function countOf(value: unknown): number {
  const count = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    invalid("原神世界 BOSS 响应的击杀数无效。");
  }
  return count;
}

function verifyIdentity(data: Json, role: { readonly uid: string; readonly region: string }) {
  for (const key of ["uid", "role_id", "game_uid"]) {
    if (!Object.hasOwn(data, key)) continue;
    const value = data[key];
    if (value !== role.uid && !(typeof value === "number" && Number.isSafeInteger(value) && String(value) === role.uid)) {
      invalid("原神世界 BOSS 响应的角色与当前档案不一致。");
    }
  }
  for (const key of ["server", "region"]) {
    if (Object.hasOwn(data, key) && genshinResponseRegion(data[key]) !== role.region) {
      invalid("原神世界 BOSS 响应的区服与当前档案不一致。");
    }
  }
  if (Object.hasOwn(data, "game_biz") && data.game_biz !== "hk4e_cn") {
    invalid("原神世界 BOSS 响应的游戏与当前档案不一致。");
  }
}

export function normalizeGenshinWorldBoss(
  input: unknown,
  role: { readonly uid: string; readonly region: string },
): GenshinWorldBossSnapshot {
  const data = object(input);
  if (!data) invalid("原神世界 BOSS 响应缺少有效数据。");
  verifyIdentity(data, role);
  if (Object.hasOwn(data, "role") && data.role !== null) {
    const recordedRole = object(data.role);
    if (!recordedRole) invalid("原神世界 BOSS 响应的角色信息无效。");
    verifyIdentity(recordedRole, role);
  }
  const base = { uid: role.uid, region: role.region };
  if (!Object.hasOwn(data, "world_explorations")) return { ...base, status: "unavailable", groups: [] };
  const explorations = data.world_explorations;
  if (!Array.isArray(explorations) || explorations.length > maxGroups) {
    invalid("原神世界 BOSS 响应的探索区域格式无效。");
  }
  const groups: GenshinWorldBossGroup[] = [];
  let total = 0;
  for (const entry of explorations) {
    const group = object(entry);
    if (!group) invalid("原神世界 BOSS 响应的探索区域格式无效。");
    if (!Object.hasOwn(group, "boss_list")) continue;
    const bosses = group.boss_list;
    if (!Array.isArray(bosses) || total + bosses.length > maxBosses) {
      invalid("原神世界 BOSS 响应的敌人列表格式无效。");
    }
    total += bosses.length;
    groups.push({ name: nameOf(group.name), bosses: bosses.map((entry) => {
      const boss = object(entry);
      if (!boss) invalid("原神世界 BOSS 响应的敌人记录格式无效。");
      return { name: nameOf(boss.name), killCount: countOf(boss.kill_num) };
    }) });
  }
  return { ...base, status: groups.length || !explorations.length ? "available" : "unavailable", groups };
}

export async function readGenshinWorldBoss(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: { readonly signal?: AbortSignal } = {}, verifyProfile?: () => Promise<void>) {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "genshin-index", signal }, verifyProfile);
  return normalizeGenshinWorldBoss(data, { uid: source.role.uid, region });
}
