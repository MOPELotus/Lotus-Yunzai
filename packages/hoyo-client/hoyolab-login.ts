// Protocol adapted from seriaati/genshin.py (MIT), pinned in hoyolab-login.SOURCES.json.
import { constants, createHash, publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import type { HoyoTransport } from "./credentials.ts";
import { readGameRecordPayload } from "./game-record.ts";
import { verifyHoYoLabCookie, type HoYoLabPassportRealm } from "./hoyolab-cookie.ts";

const origin = "https://sg-public-api.hoyoverse.com";
const salt = "IZPgfb0dRPtBeLuFkdDznSZ6f4wWt6y2";
const key = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4PMS2JVMwBsOIrYWRluY
wEiFZL7Aphtm9z5Eu/anzJ09nB00uhW+ScrDWFECPwpQto/GlOJYCUwVM/raQpAj
/xvcjK5tNVzzK94mhk+j9RiQ+aWHaTXmOgurhxSp3YbwlRDvOgcq5yPiTz0+kSeK
ZJcGeJ95bvJ+hJ/UMP0Zx2qB5PElZmiKvfiNqVUk8A8oxLJdBB5eCpqWV6CUqDKQ
KSQP4sM0mZvQ1Sr4UcACVcYgYnCbTZMWhJTWkrNXqI8TMomekgny3y+d6NX/cFa6
6jozFIF4HCX5aW8bp8C8vq2tFvFbleQ/Q3CU56EWWKMrOcpmFtRmC18s9biZBVR/
8QIDAQAB
-----END PUBLIC KEY-----`;
const appHeaders = { "x-rpc-app_id": "c9oqaq3s3gu8", "x-rpc-client_type": "2",
  "x-rpc-aigis_v4": "true", "x-rpc-app_version": "4.8.0", "x-rpc-sdk_version": "2.2.0" };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const parse = (value: unknown) => typeof value === "string" ? object(JSON.parse(value)) : object(value);
const field = (value: unknown, max = 4096): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= max && /^[A-Za-z0-9._~+/%=:-]+$/u.test(value);
const id = (value: unknown): string | undefined => typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value) ? value :
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
export class HoYoLabLoginError extends Error {
  constructor(readonly kind: "input" | "network" | "api" | "response", readonly code?: number) { super(kind); }
}
export interface HoYoLabSessionCredentials {
  readonly accountId: string; readonly mid: string; readonly stoken: string;
  readonly deviceId: string; readonly realm: HoYoLabPassportRealm;
}
export interface HoYoLabLoginCredentials extends HoYoLabSessionCredentials {
  readonly cookie: string; readonly activityCookie: string;
}
export interface HoYoLabLoginChallenge {
  readonly version: 3 | 4; readonly gt: string; readonly challenge?: string;
  readonly sessionId: string; readonly riskType?: string;
}
interface ActionTicket { readonly risk_ticket: string; readonly verify_str: { readonly ticket: string; readonly verify_type: string } }
export type HoYoLabLoginStep = { readonly state: "captcha"; readonly challenge: HoYoLabLoginChallenge } |
  { readonly state: "email" } | { readonly state: "complete"; readonly credentials: HoYoLabSessionCredentials };

function ds(body?: string) {
  const time = Math.floor(Date.now() / 1000), nonce = randomBytes(6).toString("hex").slice(0, 6);
  const hash = createHash("md5").update(`salt=${salt}&t=${time}&r=${nonce}${body === undefined ? "" : `&b=${body}&q=`}`).digest("hex");
  return `${time},${nonce},${hash}`;
}

export function createHoYoLabLogin(transport: HoyoTransport) {
  async function request(path: string, payload: unknown, headers: Record<string, string>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
    const url = new URL(path, origin);
    let response: Response;
    try { response = await transport(url, { method: "POST", body: JSON.stringify(payload), headers: {
      "Content-Type": "application/json", Accept: "application/json", ...headers,
    }, redirect: "error", credentials: "omit", signal: deadline }); }
    catch { signal?.throwIfAborted(); throw new HoYoLabLoginError("network"); }
    if (!response.ok || response.redirected || response.url && response.url !== url.href) {
      await response.body?.cancel().catch(() => undefined);
      throw new HoYoLabLoginError("network");
    }
    const data = await readGameRecordPayload(response, 64 * 1024, deadline).catch(() => undefined);
    signal?.throwIfAborted();
    if (!data || !Number.isSafeInteger(data.retcode)) throw new HoYoLabLoginError("response");
    return { data, headers: response.headers };
  }
  function challenge(headers: Headers): HoYoLabLoginChallenge {
    try {
      const header = parse(headers.get("x-rpc-aigis")), data = parse(header.data);
      if (!field(header.session_id, 512) || !field(data.gt, 128)) throw Error();
      if (!data.use_v4 && !field(data.challenge, 256)) throw Error();
      return { version: data.use_v4 ? 4 : 3, sessionId: header.session_id, gt: data.gt,
        ...(!data.use_v4 && { challenge: data.challenge as string }),
        ...(field(data.risk_type, 64) && { riskType: data.risk_type }) };
    } catch { throw new HoYoLabLoginError("response"); }
  }
  return {
    start(deviceId: string = randomUUID()) {
      if (!field(deviceId, 128)) throw new HoYoLabLoginError("input");
      let encrypted: { account: string; password: string } | undefined;
      let ticket: ActionTicket | undefined, pending: HoYoLabLoginChallenge | undefined;
      let pendingAction: "login" | "resend" = "login";
      let aigis: string | undefined;
      let destroyed = false;
      function active() { if (destroyed) throw new HoYoLabLoginError("input"); }
      function interpret(result: Awaited<ReturnType<typeof request>>): HoYoLabLoginStep {
        const { data, headers } = result;
        if (data.retcode === -3101) { pending = challenge(headers); return { state: "captcha", challenge: pending }; }
        if (data.retcode === -3239) {
          try {
            const raw = parse(headers.get("x-rpc-verify")), verification = parse(raw.verify_str);
            if (!field(raw.risk_ticket, 4096) || !field(verification.ticket, 4096) || !field(verification.verify_type, 128)) throw Error();
            ticket = { risk_ticket: raw.risk_ticket, verify_str: { ticket: verification.ticket, verify_type: verification.verify_type } };
          } catch { throw new HoYoLabLoginError("response"); }
          return { state: "email" };
        }
        if (data.retcode !== 0) throw new HoYoLabLoginError("api", data.retcode as number);
        const payload = object(data.data), user = object(payload.user_info), token = object(payload.token).token;
        const accountId = id(user.aid), mid = user.mid;
        const rawRealm = headers.get("x-rpc-ma_passport_region") ?? "SG";
        if (!accountId || !field(mid, 128) || !field(token) || !token.startsWith("v2_") || !["SG", "US", "EU"].includes(rawRealm)) {
          throw new HoYoLabLoginError("response");
        }
        encrypted = undefined; ticket = undefined; pending = undefined; aigis = undefined;
        return { state: "complete", credentials: { accountId, mid, stoken: token, deviceId, realm: rawRealm as HoYoLabPassportRealm } };
      }
      async function login(signal?: AbortSignal) {
        active(); if (!encrypted) throw new HoYoLabLoginError("input");
        const result = await request("/account/ma-passport/api/appLoginByPassword", encrypted, {
          ...appHeaders, "x-rpc-device_id": deviceId, ds: ds(JSON.stringify(encrypted)),
          ...(aigis && { "x-rpc-aigis": aigis }), ...(ticket && { "x-rpc-verify": JSON.stringify({ ...ticket, verify_str: JSON.stringify(ticket.verify_str) }) }),
        }, signal);
        active(); aigis = undefined; pending = undefined; pendingAction = "login";
        return interpret(result);
      }
      return {
        deviceId,
        async password(account: string, password: string, signal?: AbortSignal) {
          active(); if (ticket || pending || typeof account !== "string" || typeof password !== "string" ||
            !account.trim() || Buffer.byteLength(account) > 245 || !password || Buffer.byteLength(password) > 245) throw new HoYoLabLoginError("input");
          const encrypt = (value: string) => publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(value)).toString("base64");
          encrypted = { account: encrypt(account.trim()), password: encrypt(password) };
          return login(signal);
        },
        async captcha(result: unknown, signal?: AbortSignal) {
          active(); if (!pending) throw new HoYoLabLoginError("input");
          const raw = object(result), values: Record<string, string> = {};
          const keys = pending.version === 4 ? ["captcha_id", "lot_number", "pass_token", "gen_time", "captcha_output"] :
            ["geetest_challenge", "geetest_validate", "geetest_seccode"];
          for (const key of keys) {
            if (!(key === "geetest_seccode" ? typeof raw[key] === "string" && /^[A-Za-z0-9_|:-]{1,1024}$/u.test(raw[key]) : field(raw[key], key === "captcha_output" ? 12000 : 1024))) throw new HoYoLabLoginError("input");
            values[key] = raw[key] as string;
          }
          if (pending.version === 4 ? values.captcha_id !== pending.gt : !values.geetest_challenge?.startsWith(pending.challenge!)) throw new HoYoLabLoginError("input");
          aigis = `${pending.sessionId};${Buffer.from(JSON.stringify(values)).toString("base64")}`;
          pending = undefined;
          return pendingAction === "resend" ? this.resend(signal) : login(signal);
        },
        async verifyEmail(code: string, signal?: AbortSignal) {
          active(); if (!ticket || !/^\d{6}$/u.test(code)) throw new HoYoLabLoginError("input");
          const result = await request("/account/ma-verifier/api/verifyActionTicketPartly", {
            action_type: "verify_for_component", action_ticket: ticket.verify_str.ticket, email_captcha: code, verify_method: 2,
          }, { ...appHeaders, "x-rpc-device_id": deviceId }, signal);
          active(); if (result.data.retcode !== 0) throw new HoYoLabLoginError("api", result.data.retcode as number);
          return login(signal);
        },
        async resend(signal?: AbortSignal): Promise<HoYoLabLoginStep> {
          active(); if (!ticket) throw new HoYoLabLoginError("input");
          const result = await request("/account/ma-verifier/api/createEmailCaptchaByActionTicket", {
            action_type: "verify_for_component", action_ticket: ticket.verify_str.ticket,
          }, { ...appHeaders, "x-rpc-device_id": deviceId, ...(aigis && { "x-rpc-aigis": aigis }) }, signal);
          active(); aigis = undefined; pendingAction = "resend";
          if (result.data.retcode === -3101) { pending = challenge(result.headers); return { state: "captcha", challenge: pending }; }
          if (result.data.retcode !== 0) throw new HoYoLabLoginError("api", result.data.retcode as number);
          return { state: "email" };
        },
        destroy() { destroyed = true; encrypted = undefined; ticket = undefined; pending = undefined; aigis = undefined; },
      };
    },
    async exchange(credentials: HoYoLabSessionCredentials, signal?: AbortSignal): Promise<HoYoLabLoginCredentials> {
      if (!id(credentials.accountId) || !field(credentials.mid, 128) || !field(credentials.stoken) ||
        !credentials.stoken.startsWith("v2_") || !field(credentials.deviceId, 128) || !["SG", "US", "EU"].includes(credentials.realm)) throw new HoYoLabLoginError("input");
      const { accountId, mid, stoken, deviceId, realm } = credentials;
      const result = await request("/account/ma-passport/token/getBySToken", { dst_token_types: [2, 4] }, {
        ...appHeaders, ds: ds(), "x-rpc-device_id": deviceId,
        Cookie: `stoken=${stoken}; mid=${mid}; ltuid_v2=${accountId}; ltmid_v2=${mid}; account_id_v2=${accountId}; account_mid_v2=${mid}`,
      }, signal);
      if (result.data.retcode !== 0) throw new HoYoLabLoginError("api", result.data.retcode as number);
      const tokens = object(result.data.data).tokens;
      if (!Array.isArray(tokens)) throw new HoYoLabLoginError("response");
      const values = new Map(tokens.map(token => [object(token).token_type, object(token).token]));
      const ltoken = values.get(2), cookieToken = values.get(4);
      if (!field(ltoken) || !field(cookieToken)) throw new HoYoLabLoginError("response");
      const cookie = `account_id_v2=${accountId}; cookie_token_v2=${cookieToken}; account_mid_v2=${mid}`;
      const activityCookie = `ltuid_v2=${accountId}; ltoken_v2=${ltoken}; ltmid_v2=${mid}`;
      const verified = await verifyHoYoLabCookie(`${cookie}; ${activityCookie}; ma_passport_region=${realm}`, transport, { signal });
      if (verified.accountId !== accountId || verified.realm !== realm || !verified.activityCookie) throw new HoYoLabLoginError("response");
      return { ...credentials, cookie: verified.cookie, activityCookie: verified.activityCookie };
    },
  };
}

export async function fetchHoYoLabLoginRoles(credentials: HoYoLabLoginCredentials, transport: HoyoTransport, signal?: AbortSignal) {
  const { openHoYoLabCheckinTransport } = await import("./hoyolab-checkin-transport.ts");
  const options = { signal, allowManualCaptcha: false, verifyProfile: async () => { signal?.throwIfAborted(); } };
  const source = { accountId: credentials.accountId, realm: credentials.realm, language: "zh-cn" };
  const clients = {
    cookie: openHoYoLabCheckinTransport({ ...source, cookie: credentials.cookie }, transport, options, "cookie"),
    ltoken: openHoYoLabCheckinTransport({ ...source, cookie: credentials.activityCookie }, transport, options, "ltoken"),
  };
  const result: Record<"gs" | "sr" | "zzz", import("@lotus-yunzai/account").GameRole[]> = { gs: [], sr: [], zzz: [] };
  for (const [game, biz] of [["gs", "hk4e_global"], ["sr", "hkrpg_global"], ["zzz", "nap_global"]] as const) {
    const rows = await clients[game === "gs" ? "cookie" : "ltoken"].roleList(biz, "HoYoLAB");
    result[game] = rows.map(value => {
      const row = object(value), uid = id(row.game_uid);
      if (!uid || typeof row.region !== "string" || !/^[A-Za-z0-9_]{1,64}$/u.test(row.region)) throw new HoYoLabLoginError("response");
      return { uid, region: row.region, gameBiz: biz, nickname: typeof row.nickname === "string" ? row.nickname.slice(0, 80) : "",
        chosen: row.is_chosen === true, ...(typeof row.level === "number" && Number.isSafeInteger(row.level) && { level: row.level }) };
    });
  }
  return result;
}
