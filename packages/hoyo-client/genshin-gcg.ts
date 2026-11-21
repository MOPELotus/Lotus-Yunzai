import { normalizeProfileRoleArtworkUrl, type ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const label = (value: unknown) => typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 48) : "";
const whole = (value: unknown, max: number) => {
  const number = typeof value === "string" && /^\d{1,4}$/u.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 && number <= max ? number : undefined;
};

const costTypes = new Set(["CostTypeAnemo", "CostTypeCryo", "CostTypeDenro", "CostTypeDendro", "CostTypeElectro",
  "CostTypeEnergy", "CostTypeGeo", "CostTypeHydro", "CostTypePyro", "CostTypeSame", "CostTypeVoid"]);
export interface GenshinDeckCard {
  readonly name: string;
  readonly image?: string;
  readonly hp?: number;
  readonly copies?: number;
  readonly costs: readonly { readonly type?: string; readonly value: number }[];
}
export interface GenshinDeck {
  readonly id: number;
  readonly characters?: readonly GenshinDeckCard[];
  readonly actions?: readonly GenshinDeckCard[];
}
export interface GenshinDeckList {
  readonly uid: string;
  readonly nickname: string;
  readonly level?: number;
  readonly decks: readonly GenshinDeck[];
}

function verify(data: Json, uid: string, region: string) {
  for (const row of [data, record(data.role)]) {
    if (!row) continue;
    if (["uid", "role_id", "game_uid"].some(key => Object.hasOwn(row, key) && String(row[key]) !== uid) ||
        ["server", "region"].some(key => Object.hasOwn(row, key) && row[key] !== region) ||
        (Object.hasOwn(row, "game_biz") && row.game_biz !== "hk4e_cn")) {
      throw new HoyoRequestError("response", "七圣召唤响应的账号角色或区服与已选档案不一致。");
    }
  }
}

function card(row: Json): GenshinDeckCard {
  const raw = Array.isArray(row.action_cost) ? row.action_cost.slice(0, 6) : [];
  const costs = raw.flatMap(entry => {
    const cost = record(entry);
    const name = label(cost?.cost_type);
    const type = costTypes.has(name) ? name === "CostTypeDendro" ? "CostTypeDenro" : name : undefined;
    const value = whole(cost?.cost_value, 99);
    return value === undefined ? [] : [{ type, value }];
  });
  return { name: label(row.name) || label(row.card_name), image: normalizeProfileRoleArtworkUrl(row.image),
    hp: whole(row.hp, 99), copies: whole(row.num, 99), costs };
}

function cards(value: unknown, max: number): readonly GenshinDeckCard[] | undefined {
  if (value == null) return;
  if (!Array.isArray(value) || value.length > max) {
    throw new HoyoRequestError("response", "七圣召唤牌组的卡牌列表格式无效。");
  }
  return value.map(entry => {
    const row = record(entry);
    if (!row) throw new HoyoRequestError("response", "七圣召唤牌组的卡牌格式无效。");
    return card(row);
  });
}

export async function readGenshinDecks(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: { readonly signal?: AbortSignal }, verifyProfile?: () => Promise<void>): Promise<GenshinDeckList> {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "genshin-gcg-deck", signal }, verifyProfile);
  const { uid } = source.role;
  verify(data, uid, region);
  if (!Array.isArray(data.deck_list) || data.deck_list.length > 100) {
    throw new HoyoRequestError("response", "七圣召唤响应缺少有效的牌组列表。");
  }
  const ids = new Set<number>();
  const decks = data.deck_list.map((value): GenshinDeck => {
    const row = record(value);
    const id = whole(row?.id, 99);
    if (!row || id === undefined || ids.has(id)) throw new HoyoRequestError("response", "七圣召唤牌组编号缺失或重复。");
    ids.add(id);
    return { id, characters: cards(row.avatar_cards, 3), actions: cards(row.action_cards, 30) };
  });
  return { uid, nickname: label(data.nickname), level: whole(data.level, 99), decks };
}


export type GenshinGcgCollectionScope = "all" | "character" | "action";
export interface GenshinGcgCollectionCard extends GenshinDeckCard {
  readonly copies: number;
  readonly wins?: number;
  readonly uses?: number;
}
export interface GenshinGcgSummary {
  readonly uid: string;
  readonly nickname: string;
  readonly level?: number;
  readonly characterCount?: readonly [gained: number, total: number];
  readonly actionCount?: readonly [gained: number, total: number];
}
export interface GenshinGcgCollection extends GenshinGcgSummary {
  readonly characters?: readonly GenshinGcgCollectionCard[];
  readonly actions?: readonly GenshinGcgCollectionCard[];
}

export async function readGenshinGcgSummary(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: { readonly signal?: AbortSignal },
  verifyProfile?: () => Promise<void>,
): Promise<GenshinGcgSummary> {
  const { uid } = source.role;
  const { data, region } = await readCnGameRecord(source, transport,
    { kind: "genshin-gcg-collection-summary", signal }, verifyProfile);
  verify(data, uid, region);
  const count = (prefix: "avatar" | "action") => {
    const gained = whole(data[`${prefix}_card_num_gained`], 9999);
    const total = whole(data[`${prefix}_card_num_total`], 9999);
    return gained !== undefined && total !== undefined && gained <= total ? [gained, total] as const : undefined;
  };
  return {
    uid, nickname: label(data.nickname), level: whole(data.level, 99),
    characterCount: count("avatar"), actionCount: count("action"),
  };
}

export async function readGenshinGcgCollection(source: ProfileRequestContext, transport: HoyoTransport,
  { scope, signal }: { readonly scope: GenshinGcgCollectionScope; readonly signal?: AbortSignal },
  verifyProfile?: () => Promise<void>,
): Promise<GenshinGcgCollection> {
  const summary = await readGenshinGcgSummary(source, transport, { signal }, verifyProfile);

  async function collect(collection: "character" | "action"): Promise<readonly GenshinGcgCollectionCard[]> {
    const { data: result, region } = await readCnGameRecord(source, transport, { kind: "genshin-gcg-cards", collection, signal }, verifyProfile);
    verify(result, summary.uid, region);
    if (!Array.isArray(result.card_list) || result.card_list.length > 999 || result.has_more === true) {
      throw new HoyoRequestError("response", "七圣召唤收藏响应未返回完整卡牌列表。");
    }
    return result.card_list.flatMap(value => {
      const row = record(value);
      if (row && row.num == null) return [];
      const copies = whole(row?.num, 9999);
      if (!row || copies === undefined) throw new HoyoRequestError("response", "七圣召唤收藏的持有张数格式无效。");
      return copies > 0 ? [{ ...card(row), copies, wins: whole(row.proficiency, 9999), uses: whole(row.use_count, 9999) }] : [];
    });
  }
  return {
    ...summary,
    characters: scope === "action" ? undefined : await collect("character"),
    actions: scope === "character" ? undefined : await collect("action"),
  };
}
