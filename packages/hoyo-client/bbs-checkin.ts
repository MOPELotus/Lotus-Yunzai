import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import { withMiyousheCaptcha } from "./captcha-business.ts";
import type { CaptchaEvent } from "./captcha.ts";
import { createHash, randomInt } from "node:crypto";
import type { ProfileAccountContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readGameRecordPayload } from "./game-record.ts";

export const bbsCheckinForums = Object.freeze({
  "1": $t("bbs-checkin.text_6d3d8653d7"), "2": $t("bbs-checkin.text_d1597c51ed"), "3": $t("bbs-checkin.text_7deeae4b7e"), "4": $t("bbs-checkin.text_a6e4fbed57"), "5": $t("bbs-checkin.text_102f77a733"),
  "6": $t("bbs-checkin.text_a2927891f0"), "8": $t("bbs-checkin.text_b1110352c9"), "9": $t("bbs-checkin.text_467c7ad0b9"), "10": $t("bbs-checkin.text_6f70b509e8"),
} as const);

export type BbsCheckinForum = keyof typeof bbsCheckinForums;

export interface BbsMissionProgress {
  readonly missionId: number;
  readonly missionKey?: string;
  readonly happenedTimes?: number;
  readonly threshold?: number;
  readonly continuousCycleTimes?: number;
  readonly isGetAward?: boolean;
}

export interface BbsMissionState {
  readonly totalPoints?: number;
  readonly remainingPoints?: number;
  readonly receivedPoints?: number;
  readonly todayTotalPoints?: number;
  readonly states: readonly BbsMissionProgress[];
}

interface BbsCheckinOptions {
  readonly signal?: AbortSignal;
  readonly notifyCaptcha?: (event: CaptchaEvent) => unknown;
  readonly allowManualCaptcha?: boolean;
  readonly verifyBinding?: () => Promise<void>;
}

interface BbsMissionReadOptions extends BbsCheckinOptions {
  readonly allowPointsOnly?: boolean;
}

type CheckinReason = "cookie-expired" | "login-expired" | "risk" | "rate-limited";

export class BbsCheckinRequestError extends HoyoRequestError {
  constructor(readonly reason: CheckinReason, status: number, retcode?: number) {
    super(status >= 400 ? "http" : "api", {
      "cookie-expired": $t("bbs-checkin.text_45d2c60d6a"),
      "login-expired": $t("bbs-checkin.text_4bcf485973"),
      risk: $t("bbs-checkin.text_1a05b73370"),
      "rate-limited": $t("bbs-checkin.text_6aa3df09b8"),
    }[reason], status, retcode);
  }
}

const bbsOrigin = "https://bbs-api.miyoushe.com";
const webOrigin = "https://webstatic.mihoyo.com";
const appVersion = "2.118.1";
const webSalt = "4751cb5557bfad5e249e58462c39fb0a";
const appSigningSalt = "t0qEgfub6cvueAPgR5m9aQWWVciEer7v";
const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
const uidKeys = ["stuid", "uid", "ltuid", "ltuid_v2", "account_id", "account_id_v2", "login_uid"];
const midKeys = ["mid", "stmid_v2", "ltmid_v2", "account_mid_v2"];
const authKeys = ["ltoken", "ltoken_v2", "cookie_token", "cookie_token_v2"];
const riskCodes = [1034, 10035, 10041];
type Json = Record<string, unknown>;

function invalidCredentials(): never {
  throw new HoyoRequestError("invalid-input", $t("bbs-checkin.text_ce007da6aa"));
}

function invalidResponse(writing: boolean): never {
  throw new HoyoRequestError("response", writing ? $t("bbs-checkin.text_a361440f2b") : $t("bbs-checkin.text_c309ee4cda"));
}

function cookieFields(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  if (raw.length > 16_384 || /[^\x20-\x7e]/u.test(raw)) invalidCredentials();
  for (const field of raw.split(";")) {
    if (!field.trim()) continue;
    const separator = field.indexOf("=");
    const name = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (separator <= 0 || !/^[!#$%&'*+.^_`|~\w-]+$/u.test(name) ||
        (fields.has(name) && fields.get(name) !== value)) invalidCredentials();
    fields.set(name, value);
  }
  return fields;
}

function validToken(value: string | undefined): value is string {
  return !!value && /^[!#-:<-~]+$/u.test(value);
}

function credentials({ account }: ProfileAccountContext, writing: boolean) {
  const session = cookieFields(account.cookie);
  const login = cookieFields(account.stokenCookie);
  const ids = new Set([
    account.stuid || undefined, account.ltuid || undefined,
    ...uidKeys.flatMap(key => [session.get(key), login.get(key)]),
  ].filter(value => value !== undefined));
  const mids = new Set([
    account.mid || undefined, ...midKeys.flatMap(key => [session.get(key), login.get(key)]),
  ].filter(value => value !== undefined));
  const [uid] = ids;
  const [mid] = mids;
  if (ids.size !== 1 || !uid || !/^[1-9]\d{0,19}$/u.test(uid) ||
      !uidKeys.some(key => session.has(key)) ||
      mids.size > 1 || (mid !== undefined && !validToken(mid))) invalidCredentials();

  const ordinaryTokens = authKeys.flatMap(key => session.has(key) ? [session.get(key)] : []);
  if (!ordinaryTokens.length || ordinaryTokens.some(value => !validToken(value))) invalidCredentials();
  const tokens = new Set([account.stoken || undefined, login.get("stoken"), session.get("stoken")]
    .filter(value => value !== undefined));
  const [stoken] = tokens;
  for (const key of ["stoken", "stuid", "stmid_v2"]) session.delete(key);
  if (writing) {
    if (tokens.size !== 1 || !validToken(stoken) ||
        (stoken.startsWith("v2_") && !mid)) invalidCredentials();
    session.set("stoken", stoken);
    session.set("stuid", uid);
    if (mid) session.set("mid", mid);
  }
  const cookie = [...session].map(([key, value]) => `${key}=${value}`).join("; ");
  if (cookie.length > 16_384) invalidCredentials();
  return { cookie, uid, mid };
}

function headersFor({ device }: ProfileAccountContext, cookie: string, body: string | undefined) {
  const writing = body !== undefined;
  const validDevice = (value: string) => /^[A-Za-z0-9_-]{1,128}$/u.test(value);
  if (writing && (!validDevice(device.id) || !validDevice(device.fp))) {
    throw new HoyoRequestError("invalid-input", $t("bbs-checkin.text_848515a190"));
  }
  const time = Math.floor(Date.now() / 1000);
  const nonce = writing ? randomInt(100001, 200000) :
    Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join("");
  const signatureInput = writing
    ? `salt=${appSigningSalt}&t=${time}&r=${nonce}&b=${body}&q=`
    : `salt=${webSalt}&t=${time}&r=${nonce}`;
  const digest = createHash("md5").update(signatureInput).digest("hex");
  const model = /^[\x20-\x7e]{1,128}$/u.test(device.model) ? device.model : "Lotus";
  const android = /^\d{1,2}(?:\.\d+){0,2}$/u.test(device.androidVersion) ? device.androidVersion : "12";
  const userAgent = writing ? "okhttp/4.9.3" :
    `Mozilla/5.0 (Linux; Android ${android}; ${model}) AppleWebKit/537.36 Mobile Safari/537.36 miHoYoBBS/${appVersion}`;
  const headers = new Headers({
    Accept: "application/json", "Content-Type": "application/json; charset=UTF-8",
    Cookie: cookie, Origin: webOrigin, Referer: `${webOrigin}/`, "User-Agent": userAgent,
    "x-rpc-app_version": appVersion, "x-rpc-client_type": writing ? "2" : "5",
    "x-rpc-channel": "miyousheluodi", "x-rpc-verify_key": "bll8iq97cem8",
    DS: `${time},${nonce},${digest}`,
  });
  if (validDevice(device.id)) {
    headers.set("x-rpc-device_id", device.id);
    if (validDevice(device.fp)) headers.set("x-rpc-device_fp", device.fp);
  }
  if (/^[\x20-\x7e]{1,128}$/u.test(device.name)) headers.set("x-rpc-device_name", device.name);
  if (model === device.model) headers.set("x-rpc-device_model", model);
  return headers;
}

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function integer(value: unknown) {
  const parsed = typeof value === "string" && /^-?\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof parsed === "number" && Number.isSafeInteger(parsed)) return parsed;
}

function count(value: unknown) {
  if (value == null) return;
  const parsed = integer(value);
  if (parsed === undefined || parsed < 0) invalidResponse(false);
  return parsed;
}

function verifyResponseIdentity(data: Json, login: ReturnType<typeof credentials>, writing: boolean) {
  for (const key of uidKeys) {
    const value = data[key];
    if (value == null) continue;
    if (value !== login.uid && !(typeof value === "number" && Number.isSafeInteger(value) && String(value) === login.uid)) {
      invalidResponse(writing);
    }
  }
  for (const key of midKeys) {
    if (data[key] != null && data[key] !== login.mid) invalidResponse(writing);
  }
}

function missionState(data: Json, allowPointsOnly: boolean): BbsMissionState {
  const totalPoints = count(data.total_points);
  const rawRemainingPoints = integer(data.can_get_points);
  const remainingPoints = rawRemainingPoints !== undefined && rawRemainingPoints >= 0 ? rawRemainingPoints : undefined;
  const receivedPoints = count(data.already_received_points);
  const todayTotalPoints = count(data.today_total_points);
  const points = { totalPoints, receivedPoints, todayTotalPoints, remainingPoints };
  // Display reads can keep known points even if the optional task list is absent.
  const rows = data.states ?? (allowPointsOnly && Object.values(points).some(value => value !== undefined) ? [] : undefined);
  if (!Array.isArray(rows)) invalidResponse(false);
  const states: BbsMissionProgress[] = [];
  const ids = new Set<number>();
  for (const value of rows) {
    const row = object(value) ?? invalidResponse(false);
    const missionId = count(row.mission_id);
    if (!missionId || ids.has(missionId)) invalidResponse(false);
    ids.add(missionId);
    const missionKey = typeof row.mission_key === "string" && /^[a-z0-9_]{1,64}$/u.test(row.mission_key)
      ? row.mission_key : undefined;
    const happenedTimes = count(row.happened_times);
    const threshold = count(row.threshold ?? object(row.mission)?.threshold);
    const continuousCycleTimes = count(row.continuous_cycle_times);
    const award = row.is_get_award;
    if (award != null && award !== 0 && award !== 1 && typeof award !== "boolean") invalidResponse(false);
    states.push({
      missionId, ...(missionKey !== undefined && { missionKey }),
      ...(happenedTimes !== undefined && { happenedTimes }), ...(threshold !== undefined && { threshold }),
      ...(continuousCycleTimes !== undefined && { continuousCycleTimes }),
      ...(award != null && { isGetAward: award === true || award === 1 }),
    });
  }
  return {
    states, ...(totalPoints !== undefined && { totalPoints }), ...(receivedPoints !== undefined && { receivedPoints }),
    ...(todayTotalPoints !== undefined && { todayTotalPoints }), ...(remainingPoints !== undefined && { remainingPoints }),
  };
}

async function request(source: ProfileAccountContext, transport: HoyoTransport, forum: BbsCheckinForum | undefined,
  { signal }: BbsCheckinOptions, verifyProfile?: () => Promise<void>) {
  const writing = forum !== undefined;
  const body = writing ? JSON.stringify({ gids: forum }) : undefined;
  const url = new URL(writing ? "/apihub/app/api/signIn" : "/apihub/wapi/getUserMissionsState?point_sn=myb", bbsOrigin);
  const login = credentials(source, writing);
  const headers = headersFor(source, login.cookie, body);
  async function guard() {
    if (signal?.aborted) throw new HoyoRequestError("transport", $t("bbs-checkin.text_6b273becc9"));
    await verifyProfile?.();
    if (signal?.aborted) throw new HoyoRequestError("transport", $t("bbs-checkin.text_6b273becc9"));
  }
  await guard();
  const timeout = AbortSignal.timeout(15_000);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let response: Response;
  try {
    response = await transport(url, {
      method: writing ? "POST" : "GET", headers, body,
      credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: deadline,
    });
  } catch {
    await guard();
    throw new HoyoRequestError("transport", writing ? $t("bbs-checkin.text_a361440f2b") : $t("bbs-checkin.text_976c972591"));
  }

  const status = response.status;
  const aigis = response.headers.get("x-rpc-aigis")?.trim();
  if (response.redirected || status === 429 || (aigis && aigis !== "{}")) {
    void response.body?.cancel().catch(() => undefined);
    await guard();
    if (response.redirected) invalidResponse(writing);
    throw new BbsCheckinRequestError(status === 429 ? "rate-limited" : "risk", status);
  }
  const payload = await readGameRecordPayload(response, 128 * 1024, deadline);
  await guard();
  if (deadline.aborted) invalidResponse(writing);
  const retcode = integer(payload?.retcode);
  const data = object(payload?.data);
  const messages = [payload?.message, payload?.msg].filter((value): value is string => typeof value === "string");
  const risk = data?.is_risk === true || (integer(data?.is_risk) ?? 0) > 0 ||
    integer(data?.risk_code) === 375 || (writing && integer(data?.success) === 1);
  if (data && (retcode === 0 || retcode === 1034 || retcode === 10035)) {
    verifyResponseIdentity(data, login, writing);
    if (writing && data.gids != null && data.gids !== forum && data.gids !== Number(forum)) invalidResponse(true);
  }
  if ((retcode !== undefined && riskCodes.includes(retcode)) || (retcode === 0 && risk) ||
      messages.some(message => /验证码|captcha|geetest|风控/iu.test(message))) {
    throw new BbsCheckinRequestError("risk", status, retcode);
  }
  if (messages.some(message => /频繁|too frequent|rate limit/iu.test(message))) {
    throw new BbsCheckinRequestError("rate-limited", status, retcode);
  }
  if (retcode === -100 && (response.ok || status === 401)) {
    throw new BbsCheckinRequestError(writing ? "login-expired" : "cookie-expired", status, retcode);
  }
  if (!response.ok) {
    throw new HoyoRequestError("http", writing ? $t("bbs-checkin.text_a361440f2b") : $t("bbs-checkin.text_14e683c3f2"), status, retcode);
  }
  if (retcode === undefined) invalidResponse(writing);
  if ((retcode === 0 || retcode === 1008) && payload?.data != null && !data) invalidResponse(writing);
  if (data) {
    verifyResponseIdentity(data, login, writing);
    if (writing && data.gids != null && data.gids !== forum && data.gids !== Number(forum)) invalidResponse(true);
  }
  if (writing && retcode === 1008) return { already: true };
  if (retcode !== 0) throw new HoyoRequestError("api", $t("bbs-checkin.text_c8412f7c1d"), status, retcode);
  return { data };
}

export async function readBbsMissionState(source: ProfileAccountContext, transport: HoyoTransport,
  options: BbsMissionReadOptions = {}, verifyProfile?: () => Promise<void>): Promise<BbsMissionState> {
  const { data } = await withMiyousheCaptcha(transport, active => request(source, active, undefined, options, verifyProfile), {
    signal: options.signal, verify: async () => { await options.verifyBinding?.(); await verifyProfile?.(); }, context: { qq: source.qq, profileId: source.profileId },
    notify: options.notifyCaptcha, allowManual: options.allowManualCaptcha, verificationCookie: () => credentials(source, true).cookie,
  });
  return missionState(data ?? invalidResponse(false), options.allowPointsOnly === true);
}

export async function submitBbsCheckin(source: ProfileAccountContext, transport: HoyoTransport, forum: BbsCheckinForum,
  options: BbsCheckinOptions = {}, verifyProfile?: () => Promise<void>): Promise<"accepted" | "already"> {
  if (typeof forum !== "string" || !Object.hasOwn(bbsCheckinForums, forum)) {
    throw new HoyoRequestError("invalid-input", $t("bbs-checkin.text_f73b03d812"));
  }
  const result = await withMiyousheCaptcha(transport, active => request(source, active, forum, options, verifyProfile), {
    signal: options.signal, verify: async () => { await options.verifyBinding?.(); await verifyProfile?.(); }, context: { qq: source.qq, profileId: source.profileId },
    notify: options.notifyCaptcha, allowManual: options.allowManualCaptcha, verificationCookie: () => credentials(source, true).cookie,
  });
  return result.already ? "already" : "accepted";
}
