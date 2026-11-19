import { createHash, randomInt } from "node:crypto";
import type { ProfileAccountContext, RefreshedCredentials } from "@lotus-yunzai/account";

export type HoyoTransport = (endpoint: URL, init: RequestInit) => Promise<Response>;

const passportOrigin = "https://passport-api.mihoyo.com";
const webOrigin = "https://api-takumi.mihoyo.com";
const appVersion = "2.118.1";
const signingSalt = "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";

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

function requestHeaders(profile: ProfileAccountContext, login: ReturnType<typeof readLogin>, query: string, type: string) {
  const { device } = profile;
  const time = Math.floor(Date.now() / 1000);
  const nonce = randomInt(100001, 200000);
  const hash = createHash("md5").update(`salt=${signingSalt}&t=${time}&r=${nonce}&b=&q=${query}`).digest("hex");
  const headers = new Headers({
    Accept: "application/json",
    Cookie: `stuid=${login.uid};stoken=${login.stoken}${login.mid ? `;mid=${login.mid}` : ""}`,
    "User-Agent": `Mozilla/5.0 (Linux; Android ${device.androidVersion || "12"}; ${device.model || "Lotus"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 miHoYoBBS/${appVersion}`,
    "x-rpc-app_version": appVersion,
    "x-rpc-client_type": type,
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
  if ((requireUid && !ids.length) || ids.some((value) => String(value) !== login.uid) ||
      mids.some((value) => !login.mid || String(value) !== login.mid)) {
    throw new Error("令牌交换返回的账号身份与档案不一致。");
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

    async function request(endpoint: URL, params: URLSearchParams, type: string) {
      endpoint.search = params.toString();
      signal?.throwIfAborted();
      await verifyProfile?.();
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(15_000);
      let response: Response;
      try {
        response = await transport(endpoint, {
          headers: requestHeaders(profile, login, params.toString(), type),
          method: "GET", redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch {
        throw new Error("令牌交换请求未完成。");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`令牌交换 HTTP 请求失败（${response.status}）。`);
      }
      let payload: Record<string, unknown>;
      try {
        payload = record(await response.json());
      } catch {
        throw new Error("令牌交换响应无法读取。");
      }
      signal?.throwIfAborted();
      await verifyProfile?.();
      signal?.throwIfAborted();
      if (payload.retcode !== 0) throw new Error("令牌交换未成功。");
      return record(payload.data);
    }

    const ltParams = new URLSearchParams();
    if (!v2) ltParams.set("stuid", login.uid);
    ltParams.set("stoken", login.stoken);
    if (!v2 && login.mid) ltParams.set("mid", login.mid);
    const lt = await request(new URL("/account/auth/api/getLTokenBySToken", passportOrigin), ltParams, "5");
    const ltoken = lt.ltoken || record(lt.token).token;
    if (!validField(ltoken)) throw new Error("令牌交换未返回有效的 ltoken。");
    checkIdentity(lt, login, false);

    const ckParams = new URLSearchParams();
    if (!v2) {
      ckParams.set("game_biz", "hk4e_cn");
      ckParams.set("uid", login.uid);
    }
    ckParams.set("stoken", login.stoken);
    if (!v2 && login.mid) ckParams.set("mid", login.mid);
    const endpoint = v2 ? new URL("/account/auth/api/getCookieAccountInfoBySToken", passportOrigin)
      : new URL("/auth/api/getCookieAccountInfoBySToken", webOrigin);
    const ck = await request(endpoint, ckParams, v2 ? "2" : "5");
    const cookieToken = ck.cookie_token;
    if (!validField(cookieToken)) throw new Error("令牌交换未返回有效的 cookie_token。");
    checkIdentity(ck, login, true);

    const ltFields = tokenFields(ltoken, "ltoken", login);
    const ckFields = tokenFields(cookieToken, "cookie_token", login);
    const loginFields = [`stoken=${login.stoken}`, `stuid=${login.uid}`,
      ...(ltoken.startsWith("v2_") ? ltFields : [`ltoken=${ltoken}`]), ...(login.mid ? [`mid=${login.mid}`] : [])];
    return { ltoken, cookie: `${[...ltFields, ...ckFields].join(";")};`, stokenCookie: `${loginFields.join(";")};` };
  };
}
