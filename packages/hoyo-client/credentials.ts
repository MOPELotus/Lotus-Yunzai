import { createHash, randomInt, randomUUID } from "node:crypto";
import type { ProfileAccountContext, RefreshedCredentials } from "@lotus-yunzai/account";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";

export type HoyoTransport = (endpoint: URL, init: RequestInit) => Promise<Response>;

const passportOrigin = "https://passport-api.mihoyo.com";
const webOrigin = "https://api-takumi.mihoyo.com";
const appVersion = "2.118.1";
const signingSalt = "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";
// Passport App exchange protocol as exercised by TeyvatGuide b11217b.
const passportApp = {
  version: "2.119.0",
  sdk: "2.44.0",
  appId: "bll8iq97cem8",
  salt: "JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS",
  lifecycleId: randomUUID(),
};

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

function legacyHeaders(profile: ProfileAccountContext, login: ReturnType<typeof readLogin>, query: string) {
  const { device } = profile;
  const time = Math.floor(Date.now() / 1000);
  const nonce = randomInt(100001, 200000);
  const hash = createHash("md5").update(`salt=${signingSalt}&t=${time}&r=${nonce}&b=&q=${query}`).digest("hex");
  const headers = new Headers({
    Accept: "application/json",
    Cookie: `stuid=${login.uid};stoken=${login.stoken}${login.mid ? `;mid=${login.mid}` : ""}`,
    "User-Agent": `Mozilla/5.0 (Linux; Android ${device.androidVersion || "12"}; ${device.model || "Lotus"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 miHoYoBBS/${appVersion}`,
    "x-rpc-app_version": appVersion,
    "x-rpc-client_type": "5",
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

function passportAppHeaders(device: ProfileAccountContext["device"], body: string) {
  const time = Math.floor(Date.now() / 1000);
  const nonce = randomInt(36 ** 6).toString(36).padStart(6, "0");
  const hash = createHash("md5").update(`salt=${passportApp.salt}&t=${time}&r=${nonce}&b=${body}&q=`).digest("hex");
  const headers = new Headers({
    Accept: "application/json", "Content-Type": "application/json",
    "User-Agent": `Mozilla/5.0 (Linux; Android 12) Mobile miHoYoBBS/${passportApp.version}`,
    "x-rpc-app_version": passportApp.version, "x-rpc-client_type": "2", "x-rpc-app_id": passportApp.appId,
    "x-rpc-game_biz": "bbs_cn", "x-rpc-sys_version": device.androidVersion || "12",
    "x-rpc-sdk_version": passportApp.sdk, "x-rpc-account_version": passportApp.sdk,
    "x-rpc-lifecycle_id": passportApp.lifecycleId, DS: `${time},${nonce},${hash}`,
  });
  if (device.id) headers.set("x-rpc-device_id", device.id);
  if (device.fp) headers.set("x-rpc-device_fp", encodeURIComponent(device.fp));
  if (device.name) headers.set("x-rpc-device_name", encodeURIComponent(device.name));
  if (device.model) headers.set("x-rpc-device_model", encodeURIComponent(device.model));
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
  return ids.length > 0;
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

    async function request(endpoint: URL, target: "LToken" | "CookieToken", init: RequestInit) {
      signal?.throwIfAborted();
      await verifyProfile?.();
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(15_000);
      const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await transport(endpoint, { ...init, redirect: "error", credentials: "omit", signal: deadline });
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
      return request(endpoint, target, { headers: legacyHeaders(profile, login, params.toString()), method: "GET" });
    }

    function requestApp(type: 2 | 4) {
      const body = JSON.stringify({
        dst_token_type: type,
        src_token: { token: login.stoken, token_type: 1 },
        mid: login.mid,
      }).replace(/[<>&='\u2028\u2029]/gu, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
      return request(new URL("/account/ma-cn-session/app/exchange", passportOrigin),
        type === 2 ? "LToken" : "CookieToken", { headers: passportAppHeaders(profile.device, body), method: "POST", body });
    }

    const mid: Record<string, string> = login.mid ? { mid: login.mid } : {};
    const lt = v2 ? await requestApp(2) : await requestLegacy(
      new URL("/account/auth/api/getLTokenBySToken", passportOrigin),
      "LToken", new URLSearchParams({ stuid: login.uid, stoken: login.stoken, ...mid }),
    );
    const ltoken = v2 ? record(lt.token).token : lt.ltoken || record(lt.token).token;
    if (!validField(ltoken) || (v2 && !ltoken.startsWith("v2_"))) {
      throw new HoyoRequestError("response", "换票没有返回有效的 LToken。");
    }
    const ltokenIdentified = checkIdentity(lt, login, false);

    const ck = v2 ? await requestApp(4) : await requestLegacy(
      new URL("/auth/api/getCookieAccountInfoBySToken", webOrigin),
      "CookieToken", new URLSearchParams({ game_biz: "hk4e_cn", uid: login.uid, stoken: login.stoken, ...mid }),
    );
    const cookieToken = v2 ? record(ck.token).token : ck.cookie_token;
    if (!validField(cookieToken) || (v2 && !cookieToken.startsWith("v2_"))) {
      throw new HoyoRequestError("response", "换票没有返回有效的 CookieToken。");
    }
    checkIdentity(ck, login, !v2 || !ltokenIdentified);

    const ltFields = tokenFields(ltoken, "ltoken", login);
    const ckFields = tokenFields(cookieToken, "cookie_token", login);
    const loginFields = [`stoken=${login.stoken}`, `stuid=${login.uid}`,
      ...(ltoken.startsWith("v2_") ? ltFields : [`ltoken=${ltoken}`]), ...(login.mid ? [`mid=${login.mid}`] : [])];
    return { ltoken, cookie: `${[...ltFields, ...ckFields].join(";")};`, stokenCookie: `${loginFields.join(";")};` };
  };
}
