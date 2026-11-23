import { readBoundedRankPayload } from "./rank-statistics.ts";

type Game = "gs" | "sr";
type Transport = (url: URL, init: RequestInit) => Promise<Response>;

export type LegacyPanelRecovery =
  { readonly state: "ready"; readonly playerData: Readonly<Record<string, unknown>> } |
  { readonly state: "unverified" | "missing" | "unavailable" | "invalid" };

const source = "https://ark.ivny.cn/panel/data";
const version = "2.1.0";
const maximum = 2 * 1024 * 1024;
const uidPattern = /^(?:18|[1-9])\d{8}$/u;
const forbidden = new Set([
  "proto", "prototype", "constructor", "authorization", "accountid", "authkey", "cookie", "cookies", "cookiev2", "cookietoken",
  "cookietokenv2", "cookieheader", "ck", "stoken", "stokenv2", "stokencookie", "ltoken", "ltokenv2", "ltuid", "stuid",
  "mid", "ltmid", "stmid", "loginticket", "token", "accesstoken", "refreshtoken", "combotoken",
  "devicefp", "password", "credential", "credentials", "secret",
]);

function object(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function rejectsKey(value: string) {
  return forbidden.has(value.toLowerCase().replace(/[^a-z0-9]/gu, ""));
}

function containsPrivateFields(value: Readonly<Record<string, unknown>>) {
  const pending: unknown[] = [value];
  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    if (entry === null || typeof entry !== "object") continue;
    for (const [key, child] of Object.entries(entry)) {
      if (rejectsKey(key)) return true;
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return false;
}

function matchesId(value: unknown, expected: string) {
  return (typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value)) && String(value) === expected;
}

function panelFor(uid: string, data: unknown) {
  const panel = object(data);
  const avatars = object(panel?.avatars);
  if (!panel || !matchesId(panel.uid, uid) || !avatars) return;
  const rows = Object.entries(avatars);
  if (!rows.length || rows.length > 256 || rows.some(([id, row]) => !/^[1-9]\d{0,7}$/u.test(id) || !matchesId(object(row)?.id, id))) return;
  if (!containsPrivateFields(panel)) return panel;
}

export async function readLegacyPanelRecovery({ game, uid, qq }: {
  readonly game: Game;
  readonly uid: string;
  readonly qq: string;
}, signal: AbortSignal, transport: Transport = fetch): Promise<LegacyPanelRecovery> {
  const invalid = { state: "invalid" } as const;
  const unavailable = { state: "unavailable" } as const;
  if ((game !== "gs" && game !== "sr") || typeof uid !== "string" || !uidPattern.test(uid) ||
      typeof qq !== "string" || !/^[1-9]\d{0,15}$/u.test(qq) || !Number.isSafeInteger(Number(qq))) return invalid;
  if (signal.aborted) return unavailable;

  const active = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  let response: Response;
  try {
    response = await transport(new URL(source), {
      method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: active,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ uid, type: game, qq: Number(qq), version }),
    });
  } catch {
    return unavailable;
  }
  if (active.aborted || response.redirected || !!response.url && response.url !== source || !response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return unavailable;
  }
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    return invalid;
  }

  let payload: Record<string, unknown> | undefined;
  try {
    payload = object(await readBoundedRankPayload(response, maximum));
  } catch {
    return active.aborted ? unavailable : invalid;
  }
  if (active.aborted) return unavailable;
  if (!payload || typeof payload.retcode !== "number") return invalid;
  if (payload.retcode === 304) return { state: "unverified" };
  if (payload.retcode === 307) return { state: "missing" };
  if (payload.retcode !== 100) return unavailable;
  const playerData = panelFor(uid, object(payload.data)?.playerData);
  return playerData ? { state: "ready", playerData } : invalid;
}
