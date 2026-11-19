import type { Game, ProfileAccountContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { readGameRecordPayload } from "./game-record.ts";

const games = {
  gs: { host: "hk4e-api.mihoyo.com", biz: "hk4e_cn", regions: ["cn_gf01", "cn_qd01"] },
  sr: { host: "public-operation-hkrpg.mihoyo.com", biz: "hkrpg_cn", regions: ["prod_gf_cn", "prod_qd_cn"] },
  zzz: { host: "public-operation-nap.mihoyo.com", biz: "nap_cn", regions: ["prod_gf_cn", "prod_qd_cn"] },
} satisfies Record<Game, { host: string; biz: string; regions: readonly string[] }>;
const tokenFamilies = [
  ["cookie_token", "account_id"], ["cookie_token_v2", "account_id_v2", "account_mid_v2"],
  ["ltoken", "ltuid"], ["ltoken_v2", "ltuid_v2", "ltmid_v2"],
] as const;
const sentFields = new Set<string>([...tokenFamilies.flat(), "mid"]);
const uidFields = ["stuid", "uid", "login_uid", "ltuid", "ltuid_v2", "account_id", "account_id_v2"];
const midFields = ["mid", "stmid_v2", "ltmid_v2", "account_mid_v2"];
const identityFields = new Set([...uidFields, ...midFields]);
const sessionFields = new Set([...sentFields, ...identityFields]);
const idPattern = /^[1-9]\d{0,19}$/u;
const valuePattern = /^[!#-:<-\[\]-~]{1,2048}$/u;
const codePattern = /^[\p{L}\p{N}_-]{1,64}$/u;
const blockedCodes = new Set([-2016, -1071, -1033, -1035]);
const responseLimit = 64 * 1024;

export type PreviewRedeemStatus = "succeeded" | "already-used" | "expired" | "invalid" | "blocked" | "unknown";

function parseCookie(raw: string, allowed: ReadonlySet<string>): Map<string, string> | undefined {
  if (raw.length > 16_384 || /[^\x20-\x7e]/u.test(raw)) return;
  const fields = new Map<string, string>();
  for (const item of raw.split(";")) {
    const separator = item.indexOf("=");
    const key = (separator === -1 ? item : item.slice(0, separator)).trim();
    if (!allowed.has(key)) continue;
    if (separator === -1) return;
    const value = item.slice(separator + 1).trim();
    if (!valuePattern.test(value) || (fields.has(key) && fields.get(key) !== value)) return;
    fields.set(key, value);
  }
  return fields;
}

function credentials({ account }: ProfileAccountContext) {
  const session = parseCookie(account.cookie, sessionFields);
  const login = parseCookie(account.stokenCookie, identityFields);
  if (!session || !login || (!session.has("cookie_token") && !session.has("cookie_token_v2"))) return;
  const ids = new Set([account.stuid || undefined, account.ltuid || undefined,
    ...uidFields.flatMap(key => [session.get(key), login.get(key)])].filter(value => value !== undefined));
  const mids = new Set([account.mid || undefined,
    ...midFields.flatMap(key => [session.get(key), login.get(key)])].filter(value => value !== undefined));
  const [id] = ids;
  const [mid] = mids;
  if (ids.size !== 1 || !id || !idPattern.test(id) || mids.size > 1 || (mid !== undefined && !valuePattern.test(mid))) return;

  for (const [tokenKey, uidKey, midKey] of tokenFamilies) {
    const token = session.get(tokenKey);
    if (token === undefined) continue;
    if (session.get(uidKey) !== id || token.startsWith("v2_") !== (midKey !== undefined) ||
        (midKey !== undefined && (token.length <= 3 || !session.has(midKey)))) return;
  }
  const cookie = [...session].filter(([key]) => sentFields.has(key)).map(([key, value]) => `${key}=${value}`).join("; ");
  return { id, cookie };
}

export function previewRedeemIdentity(source: ProfileAccountContext): string | undefined {
  return credentials(source)?.id;
}

function responseStatus(payload: Record<string, unknown> | undefined): PreviewRedeemStatus {
  const retcode = payload?.retcode;
  if (typeof retcode !== "number" || !Number.isSafeInteger(retcode)) return "unknown";
  if (blockedCodes.has(retcode)) return "blocked";
  if (retcode === -2001) return "expired";
  if (retcode === -2003) return "invalid";
  const data = payload?.data;
  const nested = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  const already = /已(?:经)?(?:被)?(?:使用|兑换|领取)|重复兑换|already (?:been )?(?:used|redeemed|claimed)/iu;
  if ([nested?.msg, payload?.message].some(message => typeof message === "string" && already.test(message))) return "already-used";
  return retcode === 0 ? "succeeded" : "unknown";
}

/**
 * Sends a single preview-code redemption on the authorized role. The caller owns the
 * role verification and must reserve submissions before calling this write operation.
 */
export async function submitPreviewCode(
  source: ProfileAccountContext, game: Game, role: { uid: string; region: string }, code: string,
  transport: HoyoTransport, signal?: AbortSignal, beforeRequest?: () => Promise<void>,
): Promise<{ status: PreviewRedeemStatus }> {
  signal?.throwIfAborted();
  if (!Object.hasOwn(games, game)) return { status: "blocked" };
  const { host, biz, regions } = games[game];
  const { uid, region } = role;
  const auth = credentials(source);
  if (!auth || !idPattern.test(uid) || !regions.includes(region)) return { status: "blocked" };
  if (!codePattern.test(code)) return { status: "invalid" };
  await beforeRequest?.();
  signal?.throwIfAborted();

  const endpoint = new URL(`https://${host}/common/apicdkey/api/webExchangeCdkey`);
  endpoint.search = new URLSearchParams({
    cdkey: code, game_biz: biz, region, uid, lang: "zh-cn", t: String(Date.now()),
  }).toString();
  const timeout = AbortSignal.timeout(20_000);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    const response = await transport(endpoint, {
      method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
      signal: deadline, headers: { Cookie: auth.cookie, Referer: "https://webstatic.mihoyo.com/", Accept: "application/json" },
    });
    if (deadline.aborted || response.redirected || (response.url && response.url !== endpoint.href)) {
      void response.body?.cancel().catch(() => undefined);
      return { status: "unknown" };
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { status: [401, 403, 429].includes(response.status) ? "blocked" : "unknown" };
    }
    const payload = await readGameRecordPayload(response, responseLimit, deadline);
    return { status: deadline.aborted ? "unknown" : responseStatus(payload) };
  } catch {
    return { status: "unknown" };
  }
}
