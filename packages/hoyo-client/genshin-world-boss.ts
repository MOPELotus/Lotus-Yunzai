import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
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
    invalid($t("genshin-world-boss.text_75ba12b239"));
  }
  const name = value.trim();
  if (!name || Buffer.byteLength(name) > 256) invalid($t("genshin-world-boss.text_75ba12b239"));
  return name;
}

function countOf(value: unknown): number {
  const count = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    invalid($t("genshin-world-boss.text_fd31ffc0bf"));
  }
  return count;
}

function verifyIdentity(data: Json, role: { readonly uid: string; readonly region: string }) {
  for (const key of ["uid", "role_id", "game_uid"]) {
    if (!Object.hasOwn(data, key)) continue;
    const value = data[key];
    if (value !== role.uid && !(typeof value === "number" && Number.isSafeInteger(value) && String(value) === role.uid)) {
      invalid($t("genshin-world-boss.text_30ef79f6c9"));
    }
  }
  for (const key of ["server", "region"]) {
    if (Object.hasOwn(data, key) && genshinResponseRegion(data[key]) !== role.region) {
      invalid($t("genshin-world-boss.text_6cb61a9a3a"));
    }
  }
  if (Object.hasOwn(data, "game_biz") && data.game_biz !== "hk4e_cn") {
    invalid($t("genshin-world-boss.text_be5a4d0107"));
  }
}

export function normalizeGenshinWorldBoss(
  input: unknown,
  role: { readonly uid: string; readonly region: string },
): GenshinWorldBossSnapshot {
  const data = object(input);
  if (!data) invalid($t("genshin-world-boss.text_fbb96dc152"));
  verifyIdentity(data, role);
  if (Object.hasOwn(data, "role") && data.role !== null) {
    const recordedRole = object(data.role);
    if (!recordedRole) invalid($t("genshin-world-boss.text_f97a1e44ef"));
    verifyIdentity(recordedRole, role);
  }
  const base = { uid: role.uid, region: role.region };
  if (!Object.hasOwn(data, "world_explorations")) return { ...base, status: "unavailable", groups: [] };
  const explorations = data.world_explorations;
  if (!Array.isArray(explorations) || explorations.length > maxGroups) {
    invalid($t("genshin-world-boss.text_647083b4e7"));
  }
  const groups: GenshinWorldBossGroup[] = [];
  let total = 0;
  for (const entry of explorations) {
    const group = object(entry);
    if (!group) invalid($t("genshin-world-boss.text_647083b4e7"));
    if (!Object.hasOwn(group, "boss_list")) continue;
    const bosses = group.boss_list;
    if (!Array.isArray(bosses) || total + bosses.length > maxBosses) {
      invalid($t("genshin-world-boss.text_c215b18b32"));
    }
    total += bosses.length;
    groups.push({ name: nameOf(group.name), bosses: bosses.map((entry) => {
      const boss = object(entry);
      if (!boss) invalid($t("genshin-world-boss.text_a8ccb77781"));
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
