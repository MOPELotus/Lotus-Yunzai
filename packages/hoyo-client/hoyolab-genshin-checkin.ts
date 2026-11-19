import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { GameRecordRequestError, readGameRecordPayload } from "./game-record.ts";
import type { HoYoLabPassportRealm } from "./hoyolab-cookie.ts";

const gameBiz = "hk4e_global";
const officialOrigin = "https://act.hoyolab.com";
const activity = "e202102251931481";
const roleEndpoint = "https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByCookieToken";
const checkinEndpoint = "https://sg-act-public-api.hoyolab.com/event/sol";
const browserUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const regions = ["os_usa", "os_euro", "os_asia", "os_cht"] as const;
const riskCodes = [1034, 10035, 10041];
type Region = typeof regions[number];
type Json = Record<string, unknown>;

export interface HoYoLabGenshinCheckinSource {
  readonly cookie: string;
  readonly accountId: string;
  readonly realm: HoYoLabPassportRealm;
  readonly language: string;
}

export interface HoYoLabGenshinRole {
  readonly uid: string;
  readonly region: Region;
  readonly gameBiz: typeof gameBiz;
  readonly chosen?: boolean;
}

export interface HoYoLabGenshinCheckinInfo {
  readonly signed: boolean;
  readonly firstBind: boolean;
  readonly totalSignDays?: number;
  readonly role?: HoYoLabGenshinRole;
}

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function asRegion(value: unknown): Region | undefined {
  return regions.find(region => region === value);
}

function decimal(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value === "string" && pattern.test(value)) return value;
}

function roleUid(value: unknown) {
  return decimal(value, /^[1-9]\d{8,9}$/u);
}

function invalidResponse(subject: string): never {
  throw new HoyoRequestError("response", `官方${subject}响应无效。`);
}

function validateSource(source: HoYoLabGenshinCheckinSource) {
  const { accountId, realm } = source;
  const cookie = typeof source.cookie === "string" ? source.cookie : "";
  const language = typeof source.language === "string" ? source.language.toLowerCase().replaceAll("_", "-") : "";
  // The profile store persists only the canonically projected Cookie returned by the official binder.
  const legacy = /^account_id=([1-9]\d{0,19}); cookie_token=([A-Za-z0-9._~+/%=-]{1,4096})$/u.exec(cookie);
  const current = /^account_id_v2=([1-9]\d{0,19}); cookie_token_v2=[A-Za-z0-9._~+/%=-]{1,4096}; account_mid_v2=([A-Za-z0-9_-]{1,128})$/u.exec(cookie);
  const aid = current?.[1] ?? legacy?.[1];
  if (!aid || aid !== accountId || legacy?.[2]?.toLowerCase().startsWith("v2_") ||
      (realm !== "SG" && realm !== "US" && realm !== "EU") || !/^[a-z]{2}-[a-z]{2}$/u.test(language)) {
    throw new HoyoRequestError("invalid-input", "原神国际服查询需要当前档案中已核验的 HoYoLAB Cookie 和有效语言。");
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

function checkinRole(data: Json, roles: ReadonlyMap<string, HoYoLabGenshinRole>, subject: string) {
  let uid: string | undefined;
  let region: Region | undefined;
  const nested = data.role == null ? undefined : object(data.role) ?? invalidResponse(subject);
  for (const row of nested ? [data, nested] : [data]) {
    for (const key of ["uid", "game_uid", "role_id"]) {
      if (!Object.hasOwn(row, key)) continue;
      const value = roleUid(row[key]);
      if (!value || (uid !== undefined && uid !== value)) invalidResponse(subject);
      uid = value;
    }
    if (Object.hasOwn(row, "region")) {
      const value = asRegion(row.region);
      if (!value || (region !== undefined && region !== value)) invalidResponse(subject);
      region = value;
    }
    if (Object.hasOwn(row, "game_biz") && row.game_biz !== gameBiz) invalidResponse(subject);
  }

  const role = uid === undefined ? undefined : roles.get(uid) ?? invalidResponse(subject);
  if (region === undefined) return;
  if (role) {
    if (role.region !== region) invalidResponse(subject);
    return role;
  }
  if (![...roles.values()].some(candidate => candidate.region === region)) invalidResponse(subject);
}

export async function openHoYoLabGenshinCheckin(source: HoYoLabGenshinCheckinSource, transport: HoyoTransport, {
  signal, verifyProfile, deviceId,
}: {
  readonly signal?: AbortSignal;
  readonly verifyProfile: () => Promise<void>;
  readonly deviceId?: string;
}) {
  const auth = validateSource(source);
  if (deviceId !== undefined && (typeof deviceId !== "string" || !browserUuid.test(deviceId))) {
    throw new HoyoRequestError("invalid-input", "原神国际服浏览器会话 ID 无效。");
  }
  const commonHeaders = { Accept: "application/json, text/plain, */*", Cookie: auth.cookie,
    Origin: officialOrigin, Referer: `${officialOrigin}/` };
  const checkinHeaders = { ...commonHeaders, "x-rpc-signgame": "hk4e" };

  async function request(url: URL, headers: HeadersInit, subject: string, body?: string): Promise<Json> {
    const writing = body !== undefined;
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
      response = await transport(url, {
        method: writing ? "POST" : "GET", headers, ...(writing && { body }),
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

    const payload = await readGameRecordPayload(response, 128 * 1024, deadline);
    await guard();
    const retcode = payload?.retcode;
    const data = object(payload?.data);
    const message = typeof payload?.message === "string" ? payload.message : "";
    const nestedRisk = object(data?.gt_result);
    if ((typeof retcode === "number" && riskCodes.includes(retcode)) ||
        [data?.is_risk, nestedRisk?.is_risk].some(flag => flag === true || flag === 1) ||
        /验证码|captcha|geetest|风控/iu.test(message)) {
      throw new GameRecordRequestError(subject, "risk", code, status, typeof retcode === "number" ? retcode : undefined);
    }
    if (retcode === -100) throw new GameRecordRequestError(subject, "expired", code, status, retcode);
    if (status === 401) throw new HoyoRequestError("http", `官方${subject}拒绝请求。`, status);
    if (typeof retcode !== "number" || !Number.isSafeInteger(retcode)) invalidResponse(subject);
    if (retcode !== 0) throw new HoyoRequestError("api", `官方${subject}拒绝请求。`, status, retcode);
    if (!data) invalidResponse(subject);
    checkAccount(data, auth, subject);
    return data;
  }

  const catalogueSubject = "原神国际服角色目录";
  const catalogueUrl = new URL(roleEndpoint);
  catalogueUrl.searchParams.set("game_biz", gameBiz);
  const data = await request(catalogueUrl, {
    ...commonHeaders, "x-rpc-language": auth.language.startsWith("zh-") ? auth.language : auth.language.slice(0, 2),
  }, catalogueSubject);
  if (!Array.isArray(data.list) || data.list.length > 64) invalidResponse(catalogueSubject);
  const roles = new Map<string, HoYoLabGenshinRole>();
  for (const entry of data.list) {
    const row = object(entry) ?? invalidResponse(catalogueSubject);
    const uid = roleUid(row.game_uid);
    const region = asRegion(row.region);
    if (!uid || !region || roles.has(uid) || (row.game_biz !== undefined && row.game_biz !== gameBiz) ||
        (row.is_chosen !== undefined && typeof row.is_chosen !== "boolean")) invalidResponse(catalogueSubject);
    checkAccount(row, auth, catalogueSubject);
    roles.set(uid, Object.freeze({ uid, region, gameBiz, ...(row.is_chosen !== undefined && { chosen: row.is_chosen }) }));
  }

  let infoRead = 0;
  let canSubmit = false;
  let submitted = false;
  return {
    roles: Object.freeze([...roles.values()]),
    async readInfo(): Promise<HoYoLabGenshinCheckinInfo> {
      const read = ++infoRead;
      canSubmit = false;
      const subject = "原神国际服签到状态";
      const infoUrl = new URL(`${checkinEndpoint}/info`);
      infoUrl.search = new URLSearchParams({ lang: auth.language, act_id: activity }).toString();
      const state = await request(infoUrl, checkinHeaders, subject);
      if (typeof state.is_sign !== "boolean" || (state.first_bind !== undefined && typeof state.first_bind !== "boolean")) {
        invalidResponse(subject);
      }
      const days = state.total_sign_day;
      const totalSignDays = typeof days === "string" && /^\d{1,2}$/u.test(days) ? Number(days) : days;
      if (totalSignDays !== undefined && (typeof totalSignDays !== "number" ||
          !Number.isInteger(totalSignDays) || totalSignDays < 0 || totalSignDays > 31)) invalidResponse(subject);
      const role = checkinRole(state, roles, subject);
      if (read === infoRead) canSubmit = !state.is_sign && state.first_bind !== true;
      return { signed: state.is_sign, firstBind: state.first_bind === true,
        ...(totalSignDays !== undefined && { totalSignDays }), ...(role && { role }) };
    },
    async submit({ blockedUids }: { readonly blockedUids: readonly string[] }): Promise<"accepted"> {
      if (submitted || !canSubmit || roles.size === 0) {
        throw new HoyoRequestError("invalid-input", "原神国际服当前账号状态无法发起签到。");
      }
      // This endpoint selects the account default role. Any matching exclusion blocks the write.
      if (!Array.isArray(blockedUids) || blockedUids.some(uid => typeof uid !== "string" || !/^[1-9]\d{0,19}$/u.test(uid)) ||
          blockedUids.some(uid => roles.has(uid))) {
        throw new HoyoRequestError("invalid-input", "原神国际服默认角色无法安全满足签到黑名单。");
      }
      submitted = true;
      const subject = "原神国际服签到提交";
      const signUrl = new URL(`${checkinEndpoint}/sign`);
      signUrl.searchParams.set("lang", auth.language);
      const result = await request(signUrl, {
        ...checkinHeaders, "Content-Type": "application/json", "x-rpc-platform": "4",
        "x-rpc-device_id": deviceId ?? crypto.randomUUID(),
      }, subject, JSON.stringify({ act_id: activity }));
      const risk = result.gt_result == null ? undefined : object(result.gt_result) ?? invalidResponse(subject);
      if (risk?.is_risk !== undefined && risk.is_risk !== false && risk.is_risk !== 0) invalidResponse(subject);
      if (result.first_bind !== undefined && typeof result.first_bind !== "boolean") invalidResponse(subject);
      checkinRole(result, roles, subject);
      return "accepted";
    },
  };
}
