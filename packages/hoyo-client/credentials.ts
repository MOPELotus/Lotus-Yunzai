import { createHash, randomInt, randomUUID } from "node:crypto";
import type { ProfileAccountContext, RefreshedCredentials } from "@lotus-yunzai/account";
import { HoyoRequestError, requiresServiceVerification } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";
import { passportAppHeaders } from "./passport-qr.ts";

export type { ReadTransportInit as HoyoTransportInit } from '@lotus-yunzai/http';
import type { ReadTransport } from '@lotus-yunzai/http';
export type HoyoTransport = ReadTransport;

const passportOrigin = "https://passport-api.mihoyo.com";
const webOrigin = "https://api-takumi.mihoyo.com";
const appVersion = "2.118.1";
const signingSalt = "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";
const passportExchangeSdk = "2.44.0";
const passportLifecycleId = randomUUID();

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readCookie(value: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const item of value.split(";")) {
    const i = item.indexOf("=");
    if (i > 0) fields.set(item.slice(0, i).trim(), item.slice(i + 1).trim());
  }
  return fields;
}

function validField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[;\r\n\0]/u.test(value);
}

function readLogin(account: ProfileAccountContext["account"]) {
  const login = readCookie(account.stokenCookie);
  const session = readCookie(account.cookie);
  const authoritative = [account.stuid, login.get("stuid"), login.get("uid")].filter(Boolean);
  const guesses = [account.ltuid, ...["ltuid", "ltuid_v2", "account_id", "account_id_v2"]
    .flatMap((key) => [login.get(key), session.get(key)])].filter(Boolean);
  const candidates = new Set(authoritative.length ? authoritative : guesses);
  const uid = [...candidates][0];
  const stoken = account.stoken || login.get("stoken");
  const mid = account.mid || [login, session].flatMap((cookie) =>
    ["mid", "account_mid_v2", "ltmid_v2"].map((key) => cookie.get(key))).find(Boolean) || "";
  if (candidates.size !== 1 || !uid || !/^\d+$/u.test(uid) || !validField(stoken) ||
      (mid && !validField(mid)) || (stoken.startsWith("v2_") && !mid)) {
    throw new Error("档案登录信息缺失或账号归属冲突。");
  }
  return { uid, stoken, mid };
}

export function needsLegacyCookieRepair(account: ProfileAccountContext["account"]): boolean {
  if (!account.cookie.trim()) return false;
  const session = readCookie(account.cookie);
  let owner: ReturnType<typeof readLogin>;
  try { owner = readLogin(account); }
  catch { return false; }
  const storedLogin = readCookie(account.stokenCookie);
  if (storedLogin.get("ltoken")?.startsWith("v2_") || (storedLogin.has("ltoken_v2") &&
      (storedLogin.get("ltuid_v2") !== owner.uid || storedLogin.get("ltmid_v2") !== owner.mid))) return true;
  if (account.ltoken && account.ltoken !== (session.get("ltoken_v2") || session.get("ltoken"))) return true;
  return ([ ["ltoken", "ltuid", "ltmid_v2"], ["cookie_token", "account_id", "account_mid_v2"] ] as const).some(([token, id, mid]) => {
    const legacy = session.get(token), modern = session.get(token + "_v2");
    if (legacy?.startsWith("v2_") || (!legacy && !modern)) return true;
    return (legacy && session.get(id) !== owner.uid) ||
      (modern && (!owner.mid || session.get(id + "_v2") !== owner.uid || session.get(mid) !== owner.mid));
  });
}

function legacyHeaders(device: ProfileAccountContext["device"], login: ReturnType<typeof readLogin>, query: string) {
  const time = Math.floor(Date.now() / 1000);
  const nonce = randomInt(100001, 200000);
  const hash = createHash("md5").update(`salt=${signingSalt}&t=${time}&r=${nonce}&b=&q=${query}`).digest("hex");
  const headers = new Headers({
    Accept: "application/json",
    Cookie: `stuid=${login.uid};stoken=${login.stoken}${login.mid ? `;mid=${login.mid}` : ""}`,
    "User-Agent": `Mozilla/5.0 (Linux; Android ${device.androidVersion || "12"}; ${device.model || "Lotus"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 miHoYoBBS/${appVersion}`,
    "x-rpc-app_version": appVersion,
    "x-rpc-client_type": "5",
    "x-rpc-aigis": "",
    "x-requested-with": "com.mihoyo.hyperion",
    Referer: "https://webstatic.mihoyo.com/",
    DS: `${time},${nonce},${hash}`,
  });
  if (device.id) {
    headers.set("x-rpc-device_id", device.id);
    if (device.fp) headers.set("x-rpc-device_fp", device.fp);
  }
  if (device.name) headers.set("x-rpc-device_name", device.name);
  if (device.model) headers.set("x-rpc-device_model", device.model);
  return headers;
}

function checkIdentity(data: Record<string, unknown>, login: ReturnType<typeof readLogin>, requireUid: boolean) {
  const user = record(data.user_info);
  const ids = [data.uid, data.aid, data.account_id, user.aid, user.uid]
    .filter((value) => value !== undefined && value !== null && value !== "");
  const mids = [data.mid, user.mid, data.account_mid_v2].filter(Boolean);
  if ((requireUid && !ids.length) || ids.some((value) =>
      (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) || String(value) !== login.uid) ||
      mids.some((value) => !login.mid || String(value) !== login.mid)) {
    throw new HoyoRequestError("profile-changed", "令牌交换返回的账号身份与档案不一致。");
  }
}

function tokenFields(token: string, key: "ltoken" | "cookie_token", login: ReturnType<typeof readLogin>) {
  const uidKey = key === "ltoken" ? "ltuid" : "account_id";
  if (!token.startsWith("v2_")) return [`${key}=${token}`, `${uidKey}=${login.uid}`];
  if (!login.mid) throw new Error("v2 令牌缺少配套的账号 MID。");
  const midKey = key === "ltoken" ? "ltmid_v2" : "account_mid_v2";
  return [`${key}_v2=${token}`, `${uidKey}_v2=${login.uid}`, `${midKey}=${login.mid}`];
}

export function createCredentialExchange(transport: HoyoTransport = fetch) {
  return async function exchange(profile: ProfileAccountContext, { signal, verifyProfile }: {
    readonly signal?: AbortSignal;
    readonly verifyProfile?: () => Promise<void>;
  } = {}): Promise<RefreshedCredentials> {
    const login = readLogin(profile.account);
    const v2 = login.stoken.startsWith("v2_");
    const device = profile.device.id ? profile.device : {
      ...profile.device, id: randomUUID().replaceAll("-", "").toUpperCase(), fp: "",
    };

    async function request(endpoint: URL, target: "LToken" | "CookieToken", init: RequestInit) {
      signal?.throwIfAborted();
      await verifyProfile?.();
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(15_000);
      const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await transport(endpoint, { ...init, redirect: "error", credentials: "omit", proxy: false, signal: deadline });
      } catch {
        signal?.throwIfAborted();
        throw new HoyoRequestError("transport", `${target} 换票请求未完成。`);
      }
      if (!response.ok || response.redirected || (response.url && response.url !== endpoint.href)) {
        await response.body?.cancel().catch(() => undefined);
        throw new HoyoRequestError("http", `${target} 换票 HTTP 请求失败。`, response.status);
      }
      const verification = response.headers.get("x-rpc-aigis")?.trim();
      if (verification && verification !== "{}") {
        await response.body?.cancel().catch(() => undefined);
        throw new HoyoRequestError("api", `${target} 换票需要在官方客户端完成验证。`, response.status);
      }
      const payload = await readGameRecordPayload(response, 32 * 1024, deadline);
      signal?.throwIfAborted();
      await verifyProfile?.();
      signal?.throwIfAborted();
      if (timeout.aborted) throw new HoyoRequestError("transport", `${target} 换票超时。`);
      if (!payload) throw new HoyoRequestError("response", `${target} 换票响应无法读取。`, response.status);
      if (requiresServiceVerification(payload)) {
        throw new HoyoRequestError("api", `${target} 换票暂时无法核验。`, response.status);
      }
      const rawCode = payload.retcode;
      const retcode = typeof rawCode === "string" && /^-?\d{1,10}$/u.test(rawCode) ? Number(rawCode) : rawCode;
      if (retcode !== 0) {
        throw new HoyoRequestError("api", `${target} 换票未成功。`, response.status,
          typeof retcode === "number" && Number.isSafeInteger(retcode) ? retcode : undefined);
      }
      return record(payload.data);
    }

    function requestLegacy(endpoint: URL, target: "LToken" | "CookieToken", params: URLSearchParams) {
      endpoint.search = params.toString();
      return request(endpoint, target, { headers: legacyHeaders(device, login, params.toString()), method: "GET" });
    }

    function requestApp(type: 2 | 4) {
      const body = JSON.stringify({
        dst_token_type: type,
        src_token: { token: login.stoken, token_type: 1 },
        mid: login.mid,
      }).replace(/[<>&='\u2028\u2029]/gu, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
      const headers = passportAppHeaders(device, body, passportExchangeSdk);
      headers.set("x-rpc-account_version", passportExchangeSdk);
      headers.set("x-rpc-lifecycle_id", passportLifecycleId);
      return request(new URL("/account/ma-cn-session/app/exchange", passportOrigin),
        type === 2 ? "LToken" : "CookieToken", { headers, method: "POST", body });
    }

    const mid: Record<string, string> = login.mid ? { mid: login.mid } : {};
    const lt = v2 ? await requestApp(2) : await requestLegacy(
      new URL("/account/auth/api/getLTokenBySToken", passportOrigin),
      "LToken", new URLSearchParams({ stuid: login.uid, stoken: login.stoken, ...mid }),
    );
    const ltoken = lt.ltoken || record(lt.token).token;
    if (!validField(ltoken)) {
      throw new HoyoRequestError("response", "换票没有返回有效的 LToken。");
    }
    checkIdentity(lt, login, false);

    const ck = v2 ? await requestApp(4) : await requestLegacy(
      new URL("/auth/api/getCookieAccountInfoBySToken", webOrigin),
      "CookieToken", new URLSearchParams({ game_biz: "hk4e_cn", uid: login.uid, stoken: login.stoken, ...mid }),
    );
    const cookieToken = ck.cookie_token || record(ck.token).token;
    if (!validField(cookieToken)) {
      throw new HoyoRequestError("response", "换票没有返回有效的 CookieToken。");
    }
    checkIdentity(ck, login, true);

    const ltFields = tokenFields(ltoken, "ltoken", login);
    const ckFields = tokenFields(cookieToken, "cookie_token", login);
    const loginFields = [`stoken=${login.stoken}`, `stuid=${login.uid}`,
      ...(ltoken.startsWith("v2_") ? ltFields : [`ltoken=${ltoken}`]), ...(login.mid ? [`mid=${login.mid}`] : [])];
    return { ltoken, cookie: `${[...ltFields, ...ckFields].join(";")};`, stokenCookie: `${loginFields.join(";")};` };
  };
}
