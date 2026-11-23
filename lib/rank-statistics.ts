// Ark protocol reference e81b5ef9111294c17b2b489aee9a94e4ebc0c9c6. See rank-statistics.LICENSE.
const endpoint = "https://ark.ivny.cn";
const legacyVersion = "2.1.0";
const maxBytes = 64 * 1024;

export const rankPercentiles = [1, 5, 10, 20, 30, 50, 70, 90, 95, 99] as const;
const messages: Readonly<Record<number, string>> = {
  [-1]: "排名服务要求更新客户端版本。",
  101: "排名中没有此角色编号。",
  102: "暂无此角色的伤害排名数据。",
  103: "排名服务拒绝了此次排名统计查询。",
  104: "排名查询过于频繁，请稍后重试。",
  201: "排名查询过于频繁，请稍后重试。",
};

export type DamageRankStats = {
  readonly title: string;
  readonly total: number;
  readonly scores: readonly number[];
};
type RankStatsResult = { readonly stats: DamageRankStats } | { readonly message: string };
export type RankStatsTransport = (url: string, init: RequestInit) => Promise<Response>;

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown) {
  return typeof value === "string" && value.isWellFormed()
    ? value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 90) : "";
}

function sampleCount(value: unknown) {
  const count = typeof value === "string" && /^\d{1,13}$/u.test(value) ? Number(value) : value;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function score(value: unknown) {
  const number = typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER
    ? number : undefined;
}

export function readRankStatsPayload(input: unknown): RankStatsResult {
  // Ark's recent protocol returns [artifact, damage]. Old releases return only damage.
  const result = object(Array.isArray(input) ? input[1] : input);
  if (result?.retcode !== 100) {
    const code = result?.retcode;
    return { message: typeof code === "number" && messages[code] ? messages[code]! : "排名服务暂时无法返回伤害排名统计。" };
  }
  const data = object(result.data);
  const total = sampleCount(data?.total);
  if (total === 0) return { message: "暂无此角色的伤害排名样本。" };
  const title = text(data?.name);
  const values = data?.scores;
  if (!title || total === undefined || !Array.isArray(values) || values.length < rankPercentiles.length || values.length > 64) {
    return { message: "排名服务返回的伤害排名统计不完整。" };
  }
  const scores = values.slice(0, rankPercentiles.length).map(score).filter(item => item !== undefined);
  if (scores.length !== rankPercentiles.length) return { message: "排名服务返回的伤害排名统计不完整。" };
  return { stats: { title, total, scores } };
}

async function responsePayload(response: Response, maximum: number) {
  if (!response.body) return;
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body.cancel().catch(() => undefined);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let content = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) return;
      content += decoder.decode(value, { stream: true });
    }
    return JSON.parse(content + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

type RankResponse = { readonly payload: unknown } | { readonly message: string };

export async function postArkQuery(route: "rank/specific" | "rank/data" | "rank/custom" | "rank/custom/specific", query: object,
  signal: AbortSignal, transport: RankStatsTransport, { maximum = maxBytes, token }: {
    readonly maximum?: number; readonly token?: string;
  } = {}): Promise<RankResponse> {
  try {
    signal.throwIfAborted();
    const response = await transport(`${endpoint}/${route}`, {
      method: "POST", credentials: "omit", redirect: "error",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ ...query, version: legacyVersion }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    });
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => undefined);
      return { message: response.status === 429 ? messages[104]! : "排名服务暂时无法连接。" };
    }
    return { payload: await responsePayload(response, maximum) };
  } catch {
    return { message: "排名服务暂时无法连接。" };
  }
}

export async function fetchRankStats(id: number, signal: AbortSignal, transport: RankStatsTransport = fetch): Promise<RankStatsResult> {
  if (!Number.isSafeInteger(id) || id < 1) return { message: "此角色没有有效的排名统计编号。" };
  const result = await postArkQuery("rank/specific", { id, percent: 0 }, signal, transport);
  return "message" in result ? result : readRankStatsPayload(result.payload);
}

const uidPattern = /^[1-9]\d{8,9}$/u;
const rankCommand = /^(#(?:原神|星铁)?|\*)角色排名([^#]*)$/u;
type RankGame = "gs" | "sr";

function damageRankArguments(input: string) {
  const explicit = /^(.{1,40}?)\s+([1-9]\d{8,9})$/u.exec(input);
  const attached = /^(.{0,39}?[^\d\s])([1-9]\d{8,9})$/u.exec(input);
  const match = explicit ?? attached;
  return match ? { name: match[1]!.trim(), uid: match[2]! } : undefined;
}

export function matchPublicDamageRank(message: string, game: RankGame) {
  const match = rankCommand.exec(message);
  if (!match) return;
  const prefix = match[1]!;
  if (prefix !== "#" && (prefix === "#原神" ? game !== "gs" : game !== "sr")) return;
  return { explicitGame: prefix !== "#", query: damageRankArguments(match[2]!.trim()) };
}

export async function fetchPublicDamageRank(uid: string, id: number, signal: AbortSignal,
  transport: RankStatsTransport = fetch): Promise<{ readonly rank: number; readonly score: number } | { readonly message: string }> {
  if (!uidPattern.test(uid) || !Number.isSafeInteger(id) || id < 1) return { message: "角色或 UID 无效。" };
  const result = await postArkQuery("rank/data", { uid, id, update: 0 }, signal, transport);
  if ("message" in result) return result;
  const row = object(result.payload);
  if (row?.retcode !== 100) {
    const code = row?.retcode;
    return { message: code === 102 ? "此 UID 的该角色暂无全服伤害排名。" :
      typeof code === "number" && messages[code] ? messages[code]! : "排名服务暂时无法返回全服位次。" };
  }
  const rank = sampleCount(row.rank);
  const amount = score(row.score);
  return rank && amount !== undefined ? { rank, score: amount } : { message: "排名服务返回的全服位次不完整。" };
}

export async function queryPublicDamageRank(message: string, game: RankGame,
  resolve: (name: string) => Promise<{ readonly id: number; readonly name: string } | undefined>,
  signal: AbortSignal, transport?: RankStatsTransport) {
  const match = matchPublicDamageRank(message, game);
  if (!match || signal.aborted) return;
  const prefix = game === "gs" ? "#" : "*";
  if (!match.query) return game === "gs" || match.explicitGame
    ? `用法：${prefix}角色排名 角色名 UID` : undefined;
  const character = await resolve(match.query.name);
  if (signal.aborted) return;
  if (!character) return match.explicitGame ? "找不到该游戏的角色。请检查角色名和 UID。" : undefined;
  const result = await fetchPublicDamageRank(match.query.uid, character.id, signal, transport);
  if (signal.aborted) return;
  return "message" in result ? result.message :
    `UID ${match.query.uid} 的${character.name}全服伤害排名为 ${result.rank}，伤害评分 ${result.score.toFixed(2)}。`;
}
