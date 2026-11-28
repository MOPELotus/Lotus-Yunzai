import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import type { Game, ProfileAccountContext } from "@lotus-yunzai/account";
import { randomUUID } from "node:crypto";
import type { HoyoTransport } from "./credentials.ts";
import { readGameRecordPayload } from "./game-record.ts";
import { HoyoRequestError } from "./errors.ts";
import { openHoYoLabCheckinTransport, type HoYoLabCheckinAccount,
  type HoYoLabCheckinOptions } from "./hoyolab-checkin-transport.ts";
import { openHoYoLabGenshinCheckin } from "./hoyolab-genshin-checkin.ts";
import { openHoYoLabStarRailCheckin } from "./hoyolab-starrail-checkin.ts";
import { openHoYoLabZzzCheckin } from "./hoyolab-zzz-checkin.ts";

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
const blockedCodes = new Set([-2016, -1071, -1033, -1035, -2008, -2011, -2021, 1034, 10035, 10041, -3101]);
const responseLimit = 64 * 1024;

export type PreviewRedeemStatus = "succeeded" | "already-used" | "expired" | "invalid" | "blocked" | "unknown";
export type InternationalRedeemStatus = PreviewRedeemStatus | "login-expired";
export type InternationalRedeemGame = Game;

export function isRedeemCode(value: string) {
  return codePattern.test(value);
}

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
  if ([-2003, -2004, -2006, -2014, -1065].includes(retcode)) return "invalid";
  if (retcode === -2017 || retcode === -2018) return "already-used";
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
  return requestRedemption(endpoint, auth.cookie, "https://webstatic.mihoyo.com/", transport, signal, () => "blocked", responseStatus);
}

export async function openHoYoLabRedemption(
  source: HoYoLabCheckinAccount & { readonly activityCookie?: string }, game: InternationalRedeemGame,
  transport: HoyoTransport, options: HoYoLabCheckinOptions,
) {
  const { signal, verifyProfile } = options;
  if (!Object.hasOwn(games, game)) throw new HoyoRequestError("invalid-input", $t("redeem-submit.text_d1b88f9b64"));
  const genshin = game === "gs";
  // Validate the verified CookieToken independently from the activity credential used by the Star Rail role list.
  if (!genshin) openHoYoLabCheckinTransport(source, transport, options, "cookie");
  const { roles } = genshin ? await openHoYoLabGenshinCheckin(source, transport, options)
    : game === "sr" ? await openHoYoLabStarRailCheckin({ ...source, cookie: source.activityCookie ?? "" }, transport, options)
    : await openHoYoLabZzzCheckin({ ...source, cookie: source.activityCookie ?? "" }, transport, options);
  const host = genshin ? "public-operation-hk4e.hoyoverse.com" : game === "sr" ? "public-operation-hkrpg.hoyoverse.com" : "public-operation-nap.hoyoverse.com";
  const origin = genshin ? "https://genshin.hoyoverse.com" : game === "sr" ? "https://hsr.hoyoverse.com" : "https://zenless.hoyoverse.com";
  const gameBiz = genshin ? "hk4e_global" : game === "sr" ? "hkrpg_global" : "nap_global";
  const deviceId = options.deviceId ?? randomUUID();
  return {
    roles,
    async submit(code: string, role: { readonly uid: string; readonly region: string },
      reserve: () => Promise<boolean>): Promise<InternationalRedeemStatus | "duplicate"> {
      if (!codePattern.test(code)) return "invalid";
      if (!roles.some(bound => bound.uid === role.uid && bound.region === role.region && bound.gameBiz === gameBiz)) {
        throw new HoyoRequestError("invalid-input", $t("redeem-submit.text_d1b88f9b64"));
      }
      const endpoint = new URL(`https://${host}/common/apicdkey/api/${genshin ? 'webExchangeCdkey' : 'webExchangeCdkeyRisk'}`);
      const fields = { cdkey: code, game_biz: gameBiz, region: role.region, uid: role.uid, lang: "zh-cn" };
      if (genshin) endpoint.search = new URLSearchParams(fields).toString();
      if (!genshin && !Number.isSafeInteger(Number(role.uid))) throw new HoyoRequestError("invalid-input", $t("redeem-submit.text_d1b88f9b64"));
      const body = genshin ? undefined : JSON.stringify({ ...fields, uid: Number(role.uid), device_uuid: deviceId, platform: "4", t: Math.floor(Date.now() / 1000) });
      await verifyProfile();
      signal?.throwIfAborted();
      if (!await reserve()) return "duplicate";
      await verifyProfile();
      signal?.throwIfAborted();
      const result = await requestRedemption(endpoint, source.cookie, `${origin}/`, transport, signal,
        status => status === 401 ? "login-expired" : "blocked",
        payload => payload?.retcode === -100 || payload?.retcode === -1071 ? "login-expired" : responseStatus(payload),
        { method: genshin ? "GET" : "POST", body, origin });
      return result.status;
    },
  };
}

async function requestRedemption<T extends InternationalRedeemStatus>(
  endpoint: URL, cookie: string, referer: string, transport: HoyoTransport, signal: AbortSignal | undefined,
  denied: (status: number) => T, read: (payload: Record<string, unknown> | undefined) => T,
  request: { readonly method: "GET" | "POST"; readonly body?: string; readonly origin?: string } = { method: "GET" },
): Promise<{ status: T | "unknown" }> {
  const timeout = AbortSignal.timeout(20_000);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    const response = await transport(endpoint, {
      method: request.method, body: request.body, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
      signal: deadline, headers: { Cookie: cookie, Referer: referer, Accept: "application/json",
        ...(request.origin && { Origin: request.origin }), ...(request.body && { "Content-Type": "application/json" }) },
    });
    if (deadline.aborted || response.redirected || (response.url && response.url !== endpoint.href)) {
      void response.body?.cancel().catch(() => undefined);
      return { status: "unknown" };
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { status: [401, 403, 429].includes(response.status) ? denied(response.status) : "unknown" };
    }
    const challenge = response.headers.get("x-rpc-aigis")?.trim();
    if (challenge && challenge !== "{}") {
      void response.body?.cancel().catch(() => undefined);
      return { status: denied(403) };
    }
    const payload = await readGameRecordPayload(response, responseLimit, deadline);
    return { status: deadline.aborted ? "unknown" : read(payload) };
  } catch {
    return { status: "unknown" };
  }
}
