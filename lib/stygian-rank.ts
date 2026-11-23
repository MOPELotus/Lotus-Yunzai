// Request and result fields follow Ark e81b5ef. See rank-statistics.LICENSE.
import { postArkQuery, readBoundedRankPayload, type RankStatsTransport } from "./rank-statistics.ts";

export type StygianRankSite = "ark" | "akasha";
export type StygianRankResult = {
  readonly uid: string;
  readonly difficulty: number;
  readonly seconds: number;
  readonly rank: number;
  readonly total?: number;
};
type SiteResult = { readonly status: "ok"; readonly rows: readonly StygianRankResult[] } |
  { readonly status: "unavailable" } | { readonly status: "unverified"; readonly retryIndividually?: true };

const uidPattern = /^[1-9]\d{8,9}$/u;
const versionPattern = /^\d{1,2}\.\d$/u;
const maximumUids = 50;

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === "string" && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= min && number <= max ? number : undefined;
}

function matchRows(site: StygianRankSite, data: unknown, uids: readonly string[], akashaTotal?: number): SiteResult {
  if (!Array.isArray(data) || data.length > uids.length) return { status: "unverified" };
  if (site === "ark" && uids.length > 1 && data.some(value => value !== null) &&
      data.every(value => value === null || (object(value) !== undefined && !Object.hasOwn(value, "uid")))) {
    return { status: "unverified", retryIndividually: true };
  }
  const requested = new Set(uids);
  const rows: StygianRankResult[] = [];
  for (const value of data) {
    if (value === null && site === "ark") continue;
    const row = object(value);
    if (!row) return { status: "unverified" };
    const rawUid = row.uid;
    // A legacy Ark reply can omit UIDs. Only a single-request reply then has an unambiguous owner.
    const uid = rawUid === undefined && site === "ark" && uids.length === 1
      ? uids[0] : typeof rawUid === "number" || typeof rawUid === "string" ? String(rawUid) : undefined;
    if (!uid || !requested.delete(uid)) return { status: "unverified" };
    const ark = site === "ark";
    const difficulty = integer(ark ? row.hard : row.stygianIndex, 1, 6);
    const seconds = integer(ark ? row.time : row.stygianSeconds, 0, 2047);
    const rank = integer(ark ? row.rank : row.index, 1);
    const total = ark ? integer(row.sum, 1) : akashaTotal;
    if (difficulty === undefined || seconds === undefined || rank === undefined) continue;
    rows.push({ uid, difficulty, seconds, rank, ...(total !== undefined && total >= rank ? { total } : {}) });
  }
  return { status: "ok", rows };
}

async function fetchAkasha(uids: readonly string[], version: string, signal: AbortSignal, transport: RankStatsTransport) {
  const url = new URL("https://akasha.cv/api/leaderboards/stygian");
  url.search = new URLSearchParams({
    sort: "stygianScore", order: uids.length ? "-1" : "1", size: uids.length ? "50" : "1",
    page: "1", uids: uids.map(uid => `[uid]${uid}`).join(""), p: "", fromId: "", li: "", uid: "",
    version: version.replace(".", "_"),
  }).toString();
  try {
    signal.throwIfAborted();
    const response = await transport(url.href, {
      method: "GET", headers: { Accept: "application/json" }, credentials: "omit", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => undefined);
      return;
    }
    const payload = object(await readBoundedRankPayload(response, 256 * 1024));
    if (Array.isArray(payload?.data)) return payload.data as readonly unknown[];
  } catch {
    return;
  }
}

export async function queryStygianRank(site: StygianRankSite, requested: readonly string[], version: string | undefined,
  signal: AbortSignal, transport: RankStatsTransport = fetch): Promise<SiteResult> {
  if (signal.aborted || requested.length > maximumUids || requested.some(uid => !uidPattern.test(uid))) {
    return { status: "unverified" };
  }
  if (!requested.length) return { status: "ok", rows: [] };
  const uids = [...new Set(requested)];
  if (site === "ark") {
    // Ark only accepts the plugin version and serves the current game period.
    if (version !== undefined) return { status: "unavailable" };
    const result = await postArkQuery("rank/stygian", { uid: uids }, signal, transport);
    const payload = "payload" in result ? object(result.payload) : undefined;
    if (signal.aborted) return { status: "unavailable" };
    if (payload?.retcode === 102) return { status: "ok", rows: [] };
    if (payload?.retcode !== 100) return { status: "unavailable" };
    return matchRows(site, payload.data, uids);
  }
  if (!version || !versionPattern.test(version)) return { status: "unverified" };
  const [rows, totals] = await Promise.all([fetchAkasha(uids, version, signal, transport),
    fetchAkasha([], version, signal, transport)]);
  if (!rows || signal.aborted) return { status: "unavailable" };
  const total = totals?.length === 1 ? integer(object(totals[0])?.index, 1) : undefined;
  return matchRows(site, rows, uids, total);
}
