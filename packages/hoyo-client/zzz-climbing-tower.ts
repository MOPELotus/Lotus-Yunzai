import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
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
  throw new HoyoRequestError("response", $t("zzz-climbing-tower.text_53aaa87438", { "field": field }));
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
  if (!Array.isArray(value)) invalid($t("zzz-climbing-tower.text_075007631d"));
  return value.slice(0, 3).map(input => {
    const row = object(input, $t("zzz-climbing-tower.text_34992f6361")) ?? invalid($t("zzz-climbing-tower.text_34992f6361"));
    const id = count(row.avatar_id ?? row.id, 999_999, $t("zzz-climbing-tower.text_df1277905d"));
    const rarity = typeof row.rarity === "string" ? row.rarity.toUpperCase() : undefined;
    return { itemId: id ? String(id) : undefined, name: text(row.name, 96), icon: text(row.icon),
      rarity: rarity === "S" || rarity === "A" || rarity === "B" ? rarity : undefined,
      score: count(row.score, 999_999_999, $t("zzz-climbing-tower.text_6b16898934")),
      percentile: count(row.rank_percent, 10_000, $t("zzz-climbing-tower.text_86c4ddbcf0")) };
  });
}

function verifyIdentity(data: Json, expected: Identity) {
  for (const key of ["uid", "game_uid", "role_id"]) {
    const id = data[key];
    if (id !== undefined && ((typeof id !== "string" && typeof id !== "number") || String(id) !== expected.uid)) {
      invalid($t("zzz-climbing-tower.text_5e66ce9fd0"));
    }
  }
  for (const key of ["region", "server"]) {
    if (data[key] !== undefined && data[key] !== expected.region) invalid($t("zzz-climbing-tower.text_e6dcb75782"));
  }
  if (data.game_biz !== undefined && data.game_biz !== "nap_cn") invalid($t("zzz-climbing-tower.text_a81ce382a1"));
}

export function normalizeZzzClimbingTower(input: unknown, identity: Identity): ZzzClimbingTowerSnapshot {
  const data = object(input, $t("zzz-climbing-tower.text_0e8b1c78c5")) ?? invalid($t("zzz-climbing-tower.text_0e8b1c78c5"));
  verifyIdentity(data, identity);
  const seasons: ZzzTowerSeason[] = [];
  for (const number of [1, 2, 3, 4] as const) {
    const branch = object(data[`climbing_tower_s${number}`], $t("zzz-climbing-tower.text_7494b08fdb", { "number": number }));
    if (!branch) continue;
    verifyIdentity(branch, identity);
    const layer = number <= 2 ? branch : object(branch.layer_info, $t("zzz-climbing-tower.text_5602f3b59b"));
    const mvp = number <= 2 ? branch : object(branch.mvp_info, $t("zzz-climbing-tower.text_7c0ac18ce6"));
    seasons.push({
      number, medal: text(layer?.medal_icon), layer: count(layer?.climbing_tower_layer, 999_999, $t("zzz-climbing-tower.text_6e35682bee")),
      score: number >= 3 ? count(layer?.total_score, 999_999_999, $t("zzz-climbing-tower.text_89e35e662a")) : undefined,
      mvp: number >= 2 ? count(mvp?.floor_mvp_num, 999_999, $t("zzz-climbing-tower.text_7c0ac18ce6")) : undefined,
      percentile: number >= 3 ? count(mvp?.rank_percent, 10_000, $t("zzz-climbing-tower.text_6570a98f28")) : undefined,
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
