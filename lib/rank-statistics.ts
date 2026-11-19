// Ark protocol reference e81b5ef9111294c17b2b489aee9a94e4ebc0c9c6. See rank-statistics.LICENSE.
const endpoint = "https://ark.ivny.cn/rank/specific";
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

async function responsePayload(response: Response) {
  if (!response.body) return;
  if (Number(response.headers.get("content-length")) > maxBytes) {
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
      if (bytes > maxBytes) return;
      content += decoder.decode(value, { stream: true });
    }
    return JSON.parse(content + decoder.decode()) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function fetchRankStats(id: number, signal: AbortSignal, transport: RankStatsTransport = fetch): Promise<RankStatsResult> {
  if (!Number.isSafeInteger(id) || id < 1) return { message: "此角色没有有效的排名统计编号。" };
  try {
    const response = await transport(endpoint, {
      method: "POST", credentials: "omit", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, percent: 0, version: legacyVersion }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    });
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => undefined);
      return { message: response.status === 429 ? messages[104]! : "排名服务暂时无法连接。" };
    }
    return readRankStatsPayload(await responsePayload(response));
  } catch {
    return { message: "排名服务暂时无法连接。" };
  }
}
