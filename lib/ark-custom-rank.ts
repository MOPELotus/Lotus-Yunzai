// Ark request and response shapes follow e81b5ef. See rank-statistics.LICENSE.
import type { MessageEvent } from "./messages.ts";
import { arkRankTokenEnvironment, arkRankTokenKey, isArkRankToken } from "./ark-rank-credentials.ts";
import { postArkQuery, type RankStatsTransport } from "./rank-statistics.ts";

const uidPattern = /^[1-9]\d{8,9}$/u;
const maskedUidPattern = /^[1-9]\d{1,2}(?:\*{4}|@{4})\d{3,4}$/u;
const queryIdPattern = /^[a-f0-9]{32}$/iu;
const columns = new Set([
  "level", "promote", "cons", "talent_a", "talent_e", "talent_q", "weapon_level",
  "weapon_promote", "weapon_affix", "dmg_avg", "mark_score", "data_time", "artis_sets",
  "pos1", "pos2", "pos3", "pos4", "pos5", "pos6",
]);
const lifetime = 300_000;

type RankGame = "gs" | "sr";
export type ArkCustomRankQuery = {
  readonly game: RankGame;
  readonly characterId: number;
  readonly metric: "damage" | "artifacts";
  readonly filters: readonly { readonly field: string; readonly operator: 0 | 1 | 2 | 3 | 4 | 5; readonly value: number | string }[];
  readonly count: number;
};
export type ArkCustomRankRow = {
  readonly uid: string;
  readonly level?: number;
  readonly cons?: number;
  readonly promote?: number;
  readonly damage?: number;
  readonly score?: number;
  readonly weaponId?: number;
  readonly weaponLevel?: number;
  readonly weaponRefinement?: number;
  readonly weaponName?: string;
  readonly talent: Readonly<Record<string, number>>;
  readonly sets: Readonly<Record<string, number>>;
};
type Failure = { readonly message: string };
type RankResult = { readonly queryId: string; readonly title?: string; readonly rows: readonly ArkCustomRankRow[] } | Failure;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function label(value: unknown) {
  return typeof value === "string" && value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value) && value.length <= 90
    ? value.trim() || undefined : undefined;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function arkPublicUid(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return;
  const uid = String(value);
  if (uidPattern.test(uid)) return uid;
  if (uid.length <= 10 && maskedUidPattern.test(uid)) return uid.replace("@@@@", "****");
}

function readRow(value: unknown): ArkCustomRankRow | undefined {
  const row = record(value);
  const uid = arkPublicUid(row?.uid);
  if (!row || !uid) return;
  const talent = Object.fromEntries(["a", "e", "q", "t", "me", "mt"].flatMap(key => {
    const level = number(row[`talent_${key}`]);
    return level === undefined ? [] : [[key, level] as const];
  }));
  const rawSets = record(record(row.artisSet)?.sets);
  const sets = Object.fromEntries(Object.entries(rawSets ?? {}).slice(0, 6).flatMap(([name, count]) => {
    const title = label(name);
    return title && positiveId(count) && count <= 6 ? [[title, count] as const] : [];
  }));
  return {
    uid, talent, sets, level: number(row.level), cons: number(row.cons), promote: number(row.promote),
    damage: number(row.dmg_avg), score: number(row.mark_score), weaponId: number(row.weapon_id),
    weaponLevel: number(row.weapon_level), weaponRefinement: number(row.weapon_affix), weaponName: label(row.weapon_name),
  };
}

function failure(result: Record<string, unknown> | undefined, missing: string): Failure {
  if (result?.retcode === 429) return { message: "排名查询过于频繁，请稍后重试。" };
  if (result?.retcode === 401 || result?.retcode === 403) return { message: "排名服务拒绝本次请求，请检查高级筛选授权。" };
  if (result?.retcode === 400 || result?.retcode === 404) return { message: missing };
  return { message: "排名服务未能返回完整结果。" };
}

export async function queryArkCustomRank(query: ArkCustomRankQuery, signal: AbortSignal, token?: string,
  transport: RankStatsTransport = fetch): Promise<RankResult> {
  const { game, characterId, metric, filters, count } = query;
  if ((game !== "gs" && game !== "sr") || !positiveId(characterId) || !positiveId(count) || count > 50 ||
      (metric !== "damage" && metric !== "artifacts") || filters.length > 20 ||
      (token !== undefined && !isArkRankToken(token))) return { message: "无效的排行查询条件。" };
  if (filters.some(({ field, operator, value }) => !columns.has(field) || (!token && field !== "cons") ||
      (field.startsWith("pos") && game !== "sr") || !Number.isInteger(operator) || operator < 0 || operator > 5 ||
      (field === "artis_sets" && typeof value === "string" ? !label(value) : number(value) === undefined))) {
    return { message: "无效的排行筛选条件，或当前没有高级筛选权限。" };
  }
  const result = await postArkQuery("rank/custom", {
    game, charId: characterId,
    data: { rank: { col: metric === "damage" ? "dmg_avg" : "mark_score", order: "desc" },
      filter: filters.map(({ field, operator, value }) => ({ type: field, rule: operator, value })), nums: count },
  }, signal, transport, { token, maximum: 256 * 1024 });
  if ("message" in result) return result;

  const payload = record(result.payload);
  const data = record(payload?.data);
  if (payload?.retcode !== 0) return failure(payload, "此角色暂无符合条件的排行。");
  if (!data || String(data.charId) !== String(characterId) ||
      (typeof data.isSr === "boolean" && data.isSr !== (game === "sr")) || !Array.isArray(data.rows) || data.rows.length > count) {
    return failure(undefined, "");
  }
  if (!data.rows.length) return { message: "此角色暂无符合条件的排行。" };
  const queryId = data.query_id ?? data.queryId;
  if (typeof queryId !== "string" || !queryIdPattern.test(queryId)) return failure(undefined, "");
  // Positions in the display must correspond to the original indices for follow-up reads.
  const rows = data.rows.map(readRow);
  if (rows.some(row => row === undefined)) return failure(undefined, "");
  return { queryId, title: label(data.dmgTitle), rows: rows as ArkCustomRankRow[] };
}

export async function queryArkCustomPanel(queryId: string, index: number, signal: AbortSignal, token?: string,
  transport: RankStatsTransport = fetch): Promise<{ readonly snapshot: unknown } | Failure> {
  if (!queryIdPattern.test(queryId) || !Number.isInteger(index) || index < 0 || index >= 20 ||
      (token !== undefined && !isArkRankToken(token))) return { message: "排行面板编号无效。" };
  const result = await postArkQuery("rank/custom/specific", { query_id: queryId, index }, signal, transport,
    { token, maximum: 2 * 1024 * 1024 });
  if ("message" in result) return result;
  const payload = record(result.payload);
  const data = record(payload?.data);
  if (payload?.retcode !== 0) return failure(payload, "排行结果已失效，请重新查询。");
  const snapshot = record(data?.info ?? data?.playerData ?? data);
  const uid = arkPublicUid(snapshot?.uid);
  if (!snapshot || !uid || (!record(snapshot.avatars) && !Array.isArray(snapshot.avatars))) {
    return { message: "排名服务返回的角色面板不完整。" };
  }
  return { snapshot: { ...snapshot, uid } };
}

export async function readArkCustomRankToken(): Promise<string | undefined> {
  const token = Bun.env[arkRankTokenEnvironment] ?? await globalThis.redis?.get(arkRankTokenKey).catch(() => undefined);
  return isArkRankToken(token) ? token : undefined;
}

type RankContext = Partial<Pick<MessageEvent, "self_id" | "user_id" | "group_id" | "reply_id" | "isDelegated">> & {
  readonly adapter?: string;
  readonly message_type?: string;
};
type RankReceipt = {
  readonly game: RankGame;
  readonly characterId: number;
  readonly name: string;
  readonly queryId: string;
  readonly count: number;
  readonly uids: readonly string[];
  readonly authorizedBy?: number;
};

function scope(context: RankContext, messageId: number | string | undefined) {
  const { adapter = "onebot", self_id: bot, message_type: scene } = context;
  const peer = scene === "group" ? context.group_id : context.user_id;
  if (context.isDelegated || !positiveId(bot) || !positiveId(peer) ||
      (adapter !== "onebot" && adapter !== "milky") || (scene !== "group" && scene !== "private")) return;
  if (typeof messageId !== "number" && (typeof messageId !== "string" || !/^-?\d{1,16}$/u.test(messageId))) return;
  const id = Number(messageId);
  if (!Number.isSafeInteger(id) || (adapter === "milky" ? id < 0 : id === 0 || id < -2147483648 || id > 2147483647)) return;
  return `${adapter}:${bot}:${scene}:${peer}:${id}`;
}

export function createArkCustomRankSessions(now = Date.now) {
  const sessions = new Map<string, { receipt: RankReceipt; expires: number }>();
  return {
    remember(context: RankContext, messageId: number, receipt: RankReceipt) {
      const key = scope(context, messageId);
      if (!key || !queryIdPattern.test(receipt.queryId) || !positiveId(receipt.count) || receipt.count > 50 ||
          receipt.uids.length !== Math.min(receipt.count, 20) || receipt.uids.some(uid => arkPublicUid(uid) !== uid) ||
          (receipt.authorizedBy !== undefined && receipt.authorizedBy !== context.user_id)) return;
      sessions.delete(key);
      if (sessions.size >= 1024) sessions.delete(sessions.keys().next().value!);
      sessions.set(key, { receipt, expires: now() + lifetime });
    },
    find(context: RankContext) {
      const key = scope(context, context.reply_id);
      if (!key) return;
      const session = sessions.get(key);
      if (session && session.expires > now()) {
        if (session.receipt.authorizedBy === undefined || session.receipt.authorizedBy === context.user_id) return session.receipt;
        return;
      }
      sessions.delete(key);
    },
  };
}

export const arkCustomRankSessions = createArkCustomRankSessions();
