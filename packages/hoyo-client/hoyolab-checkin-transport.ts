import { withMiyousheCaptcha } from "./captcha-business.ts";
import type { CaptchaEvent } from "./captcha.ts";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { GameRecordRequestError, readGameRecordPayload } from "./game-record.ts";
import type { HoYoLabPassportRealm } from "./hoyolab-cookie.ts";

const officialOrigin = "https://act.hoyolab.com";
const roleOrigin = "https://api-account-os.hoyolab.com";
const activityOrigin = "https://sg-act-public-api.hoyolab.com";
const ledgerOrigin = "https://sg-public-api.hoyolab.com";
const zzzMonthlyPath = "/event/nap_ledger/month_info";
const browserUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const riskCodes = [1034, 10035, 10041];
const cookiePaths = {
  cookie: "/binding/api/getUserGameRolesByCookieToken",
  ltoken: "/binding/api/getUserGameRolesByLtoken",
} as const;
const activityPaths = {
  cookie: ["/event/sol"],
  ltoken: ["/event/luna/hkrpg/os", "/event/luna/zzz/os", "/event/luna/nxx/os", "/event/mani"],
} as const;
const roleGames = {
  cookie: ["hk4e_global"],
  ltoken: ["hkrpg_global", "nap_global", "nxx_global", "bh3_global"],
} as const;
const zzzRecordPath = "/event/game_record_zzz/api/zzz/";
const zzzRecordParts = { index: "index", avatar: "avatar/basic", buddy: "buddy/info", note: "note" } as const;
type ZzzRecordPart = keyof typeof zzzRecordParts;
type Credential = keyof typeof cookiePaths;
type Json = Record<string, unknown>;

export interface HoYoLabCheckinAccount {
  readonly cookie: string;
  readonly accountId: string;
  readonly realm: HoYoLabPassportRealm;
  readonly language: string;
}

export interface HoYoLabCheckinOptions {
  readonly signal?: AbortSignal;
  readonly verifyProfile: () => Promise<void>;
  readonly deviceId?: string;
  readonly captchaContext?: { readonly qq: string; readonly profileId: number };
  readonly notifyCaptcha?: (event: CaptchaEvent) => unknown;
  readonly allowManualCaptcha?: boolean;
}

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function decimal(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value === "string" && pattern.test(value)) return value;
}

function invalidResponse(subject: string): never {
  throw new HoyoRequestError("response", `官方${subject}响应无效。`);
}

function validateSource(source: HoYoLabCheckinAccount, credential: Credential) {
  const { accountId, realm } = source;
  const cookie = typeof source.cookie === "string" ? source.cookie : "";
  const language = typeof source.language === "string" ? source.language.toLowerCase().replaceAll("_", "-") : "";
  const legacy = credential === "cookie"
    ? /^account_id=([1-9]\d{0,19}); cookie_token=([A-Za-z0-9._~+/%=-]{1,4096})$/u.exec(cookie)
    : /^ltuid=([1-9]\d{0,19}); ltoken=([A-Za-z0-9._~+/%=-]{1,4096})$/u.exec(cookie);
  const current = credential === "cookie"
    ? /^account_id_v2=([1-9]\d{0,19}); cookie_token_v2=[A-Za-z0-9._~+/%=-]{1,4096}; account_mid_v2=([A-Za-z0-9_-]{1,128})$/u.exec(cookie)
    : /^ltuid_v2=([1-9]\d{0,19}); ltoken_v2=[A-Za-z0-9._~+/%=-]{1,4096}; ltmid_v2=([A-Za-z0-9_-]{1,128})$/u.exec(cookie);
  const aid = current?.[1] ?? legacy?.[1];
  if (!aid || aid !== accountId || legacy?.[2]?.toLowerCase().startsWith("v2_") ||
      (realm !== "SG" && realm !== "US" && realm !== "EU") || !/^[a-z]{2}-[a-z]{2}$/u.test(language)) {
    throw new HoyoRequestError("invalid-input", "国际服请求需要同档案已核验的 HoYoLAB 登录凭据和有效语言。");
  }
  return { cookie, accountId, realm, language, mid: current?.[2] };
}

function checkAccount(data: Json, source: ReturnType<typeof validateSource>, subject: string) {
  const user = data.user_info == null ? undefined : object(data.user_info) ?? invalidResponse(subject);
  for (const row of user ? [data, user] : [data]) {
    if (["aid", "account_id", "account_id_v2"].some(key => Object.hasOwn(row, key) &&
          decimal(row[key], /^[1-9]\d{0,19}$/u) !== source.accountId) ||
        (source.mid && ["mid", "account_mid_v2", "ltmid_v2"].some(key => Object.hasOwn(row, key) && row[key] !== source.mid)) ||
        (Object.hasOwn(row, "ma_passport_region") && (typeof row.ma_passport_region !== "string" ||
          row.ma_passport_region.toUpperCase() !== source.realm))) invalidResponse(subject);
  }
}

function officialRoute(url: URL, writing: boolean, credential: Credential, zzzRecord: boolean) {
  if (url.origin === roleOrigin) return !writing && url.pathname === cookiePaths[credential];
  if (url.origin === ledgerOrigin) return zzzRecord && !writing && url.pathname === zzzMonthlyPath;
  if (url.origin !== activityOrigin) return false;
  if (zzzRecord) return !writing && Object.values(zzzRecordParts).some(part => url.pathname === zzzRecordPath + part);
  return activityPaths[credential].some(base => url.pathname === `${base}/${writing ? "sign" : "info"}`);
}

export function openHoYoLabCheckinTransport(source: HoYoLabCheckinAccount, transport: HoyoTransport,
  options: HoYoLabCheckinOptions, credential: Credential = "cookie") {
  return openHoYoLabTransport(source, transport, options, credential, false);
}

export function openHoYoLabZzzRecordTransport(source: HoYoLabCheckinAccount, transport: HoyoTransport, options: HoYoLabCheckinOptions) {
  const client = openHoYoLabTransport(source, transport, options, "ltoken", true);
  return {
    roleList: () => client.roleList("nap_global", "绝区零国际服角色目录"),
    read(part: ZzzRecordPart, uid: string, region: string) {
      const url = new URL(zzzRecordPath + zzzRecordParts[part], activityOrigin);
      const note = part === "note";
      url.search = new URLSearchParams({ ...(!note && { lang: client.language }), role_id: uid, server: region }).toString();
      return client.request(url, { "x-rpc-language": client.language }, note ? "绝区零国际服便笺" : "绝区零国际服战绩");
    },
    readMonthly(uid: string, region: string, month: string) {
      const url = new URL(zzzMonthlyPath, ledgerOrigin);
      url.search = new URLSearchParams({ uid, region, month }).toString();
      return client.request(url, { "x-rpc-language": client.language }, "绝区零国际服月报");
    },
  };
}

function openHoYoLabTransport(source: HoYoLabCheckinAccount, transport: HoyoTransport,
  { signal, verifyProfile, deviceId, captchaContext, notifyCaptcha, allowManualCaptcha }: HoYoLabCheckinOptions, credential: Credential, zzzRecord: boolean) {
  const auth = validateSource(source, credential);
  if (deviceId !== undefined && (typeof deviceId !== "string" || !browserUuid.test(deviceId))) {
    throw new HoyoRequestError("invalid-input", "国际服浏览器会话 ID 无效。");
  }
  const commonHeaders = { Accept: "application/json, text/plain, */*", Cookie: auth.cookie,
    Origin: officialOrigin, Referer: `${officialOrigin}/` };

  async function request(url: URL, headers: HeadersInit, subject: string, body?: string): Promise<Json> {
    return withMiyousheCaptcha(transport, active => requestRaw(url, headers, subject, body, active), {
      signal, verify: verifyProfile, context: captchaContext, notify: notifyCaptcha, allowManual: allowManualCaptcha,
    });
  }

  async function requestRaw(url: URL, headers: HeadersInit, subject: string, body: string | undefined, active: HoyoTransport): Promise<Json> {
    const writing = body !== undefined;
    if (url.username || url.password || url.hash || !officialRoute(url, writing, credential, zzzRecord)) {
      throw new HoyoRequestError("invalid-input", "HoYoLAB 请求地址无效。");
    }
    const signedHeaders = new Headers(headers);
    for (const [key, value] of Object.entries(commonHeaders)) signedHeaders.set(key, value);
    const timeout = AbortSignal.timeout(10_000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const transportError = () => new HoyoRequestError("transport", writing
      ? `官方${subject}结果未确认。` : `官方${subject}查询未完成。`);
    async function guard() {
      if (deadline.aborted) throw transportError();
      await verifyProfile();
      if (deadline.aborted) throw transportError();
    }
    await guard();

    let response: Response;
    try {
      response = await active(url, {
        method: writing ? "POST" : "GET", headers: signedHeaders, ...(writing && { body }),
        credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: deadline,
      });
    } catch {
      await guard();
      throw transportError();
    }
    const status = response.status;
    const code = status === 200 ? "api" : "http";
    const challenge = response.headers.get("x-rpc-aigis")?.trim();
    if (deadline.aborted || response.redirected || (response.url && response.url !== url.href) || status === 429 ||
        (challenge && challenge !== "{}") || (status !== 200 && status !== 401)) {
      void response.body?.cancel().catch(() => undefined);
      await guard();
      if (response.redirected || (response.url && response.url !== url.href)) {
        throw new HoyoRequestError(writing ? "response" : "http", `官方${subject}返回了意外的地址。`, status);
      }
      if (status === 429) throw new GameRecordRequestError(subject, "rate-limited", "http", status);
      if (challenge && challenge !== "{}") throw new GameRecordRequestError(subject, "risk", code, status);
      throw new HoyoRequestError("http", `官方${subject}返回 HTTP 错误。`, status);
    }

    const payload = await readGameRecordPayload(response, (zzzRecord && url.origin === activityOrigin ? 512 : 128) * 1024, deadline);
    await guard();
    const retcode = payload?.retcode;
    const data = object(payload?.data);
    const message = typeof payload?.message === "string" ? payload.message : "";
    const nestedRisk = object(data?.gt_result);
    if (data && (retcode === 0 || retcode === 1034 || retcode === 10035)) checkAccount(data, auth, subject);
    if ((typeof retcode === "number" && riskCodes.includes(retcode)) ||
        (retcode === 0 && [data?.is_risk, nestedRisk?.is_risk, data?.success, nestedRisk?.success].some(flag => flag === true || flag === 1)) ||
        /验证码|captcha|geetest|风控/iu.test(message)) {
      throw new GameRecordRequestError(subject, "risk", code, status, typeof retcode === "number" ? retcode : undefined);
    }
    if (retcode === -100) throw new GameRecordRequestError(subject, "expired", code, status, retcode);
    if (status === 401) throw new HoyoRequestError("http", `官方${subject}拒绝请求。`, status);
    if (typeof retcode !== "number" || !Number.isSafeInteger(retcode)) invalidResponse(subject);
    if (retcode !== 0) throw new HoyoRequestError("api", `官方${subject}拒绝请求。`, status, retcode);
    if (!data) {
      if (url.origin === ledgerOrigin && payload?.data === null) return {};
      invalidResponse(subject);
    }
    checkAccount(data, auth, subject);
    return data;
  }

  return {
    language: auth.language,
    deviceId: deviceId ?? crypto.randomUUID(),
    request,
    async roleList(gameBiz: string, subject: string): Promise<readonly unknown[]> {
      if (!roleGames[credential].some(game => game === gameBiz)) {
        throw new HoyoRequestError("invalid-input", "国际服角色目录不支持当前游戏。");
      }
      const url = new URL(cookiePaths[credential], roleOrigin);
      url.searchParams.set("game_biz", gameBiz);
      const data = await request(url, {
        "x-rpc-language": auth.language.startsWith("zh-") ? auth.language : auth.language.slice(0, 2),
      }, subject);
      if (!Array.isArray(data.list) || data.list.length > 64) invalidResponse(subject);
      for (const entry of data.list) checkAccount(object(entry) ?? invalidResponse(subject), auth, subject);
      return data.list;
    },
  };
}
