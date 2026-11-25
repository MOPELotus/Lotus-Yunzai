import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
// Battle record request contract adapted from MOPELotus/Lotus-ReFactor eaf7675
// services/starRailChallenge/service.js.
import { createHash, randomInt } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { addRecordFingerprint } from "./record-fingerprint.ts";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { observeCnRead } from "./cn-read-diagnostics.ts";
import { GameRecordRequestError, isUnspecifiedCnRecordRegion, readGameRecordPayload } from "./game-record.ts";

const routes = { hall: "challenge", story: "challenge_story", boss: "challenge_boss", peak: "challenge_peak" } as const;
export type StarRailChallengeKind = keyof typeof routes;
export type StarRailChallengePeriod = "1" | "2" | "3";
export interface StarRailChallengeOptions {
  readonly kinds: readonly StarRailChallengeKind[];
  readonly period: "current" | "last" | "recent";
  readonly simple: boolean;
  readonly signal?: AbortSignal;
}

type Json = Record<string, unknown>;
type Source = Pick<ProfileRequestContext, "game" | "role" | "device">;

export function starRailChallengeRegion({ uid, region, gameBiz }: Source["role"]) {
  if (!/^[1-5]\d{8}$/u.test(uid) || (gameBiz && gameBiz !== "hkrpg_cn")) return;
  const inferred = uid.startsWith("5") ? "prod_qd_cn" : "prod_gf_cn";
  if (isUnspecifiedCnRecordRegion(region) || region === inferred) return inferred;
}

function object(value: unknown): Json | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Json;
}

function retcodeOf(value: unknown): number | undefined {
  const code = typeof value === "string" && /^-?\d{1,8}$/u.test(value) ? Number(value) : value;
  if (typeof code === "number" && Number.isSafeInteger(code)) return code;
}

function requestHeaders(source: Source, cookie: string, query: URLSearchParams) {
  const { device } = source;
  const printable = (value: string) => !/[^\x20-\x7e]/u.test(value);
  if (!cookie.includes("=") || !printable(cookie) || !printable(device.id) || !printable(device.fp)) {
    throw new HoyoRequestError("invalid-input", $t("starrail-challenge.text_a9e2b58042"));
  }
  const appVersion = "2.118.1";
  const salt = "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";
  const origin = "https://webstatic.mihoyo.com";
  const signed = new URLSearchParams(query);
  signed.sort();
  const canonical = Array.from(signed, ([key, value]) => `${key}=${value}`).join("&");
  const time = Math.floor(Date.now() / 1000);
  const nonce = randomInt(100001, 200000);
  const hash = createHash("md5").update(`salt=${salt}&t=${time}&r=${nonce}&b=&q=${canonical}`).digest("hex");
  const android = /^\d{1,2}(?:\.\d+){0,2}$/u.test(device.androidVersion) ? device.androidVersion : "12";
  const model = device.model && printable(device.model) ? device.model : "Android";
  const headers = new Headers({
    Accept: "application/json", Cookie: cookie, Origin: origin, Referer: `${origin}/`,
    "User-Agent": `Mozilla/5.0 (Linux; Android ${android}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 miHoYoBBS/${appVersion}`,
    "x-rpc-app_version": appVersion, "x-rpc-client_type": "5", "x-rpc-csm_source": "myself",
    DS: `${time},${nonce},${hash}`,
  });
  if (device.id) headers.set("x-rpc-device_id", device.id);
  if (device.id && device.fp) headers.set("x-rpc-device_fp", device.fp);
  if (device.name && printable(device.name)) headers.set("x-rpc-device_name", device.name);
  if (device.model && printable(device.model)) headers.set("x-rpc-device_model", device.model);
  if (device.androidVersion && printable(device.androidVersion)) headers.set("x-rpc-sys_version", device.androidVersion);
  return headers;
}

class ChallengeUnavailable extends HoyoRequestError {
  constructor(status: number, code: number) {
    super("api", $t("starrail-challenge.text_df83a69be3"), status, code);
  }
}

function apiError(status: number, retcode: number | undefined, challenge: boolean): HoyoRequestError {
  const subject = $t("starrail-challenge.text_16c751a316");
  const code = status === 401 || status === 429 ? "http" : "api";
  if (status === 429) return new GameRecordRequestError(subject, "rate-limited", code, status, retcode);
  if (retcode === 10041) return new GameRecordRequestError(subject, "account", code, status, retcode);
  if (challenge || (retcode !== undefined && [1034, 10035].includes(retcode))) {
    return new GameRecordRequestError(subject, "risk", code, status, retcode);
  }
  if (status === 401 || (retcode !== undefined && [-100, 10001, 10101, 10103].includes(retcode))) {
    return new GameRecordRequestError(subject, "expired", code, status, retcode);
  }
  if (retcode === 10102 || retcode === 5003) return new ChallengeUnavailable(status, retcode);
  return new HoyoRequestError("api", $t("starrail-challenge.text_dba87bf902"), status, retcode);
}

function verifyResult(data: Json, { uid }: Source["role"], region: string) {
  const role = object(data.role);
  for (const identity of [data, role]) {
    if (!identity) continue;
    for (const name of ["role_id", "game_uid"] as const) {
      if (Object.hasOwn(identity, name) && String(identity[name]) !== uid) {
        throw new HoyoRequestError("response", $t("starrail-challenge.text_82bbd1f73d"));
      }
    }
    for (const name of ["region", "server"] as const) {
      if (Object.hasOwn(identity, name) && identity[name] !== region) {
        throw new HoyoRequestError("response", $t("starrail-challenge.text_476f451d7b"));
      }
    }
  }
}

export async function readStarRailChallenge(source: ProfileRequestContext, transport: HoyoTransport,
  options: StarRailChallengeOptions, verifyProfile?: () => Promise<void>) {
  const detectedRegion = starRailChallengeRegion(source.role);
  if (!detectedRegion) throw new HoyoRequestError("invalid-input", $t("starrail-challenge.text_594b1c433e"));
  const region: string = detectedRegion;
  const { kinds, simple, period, signal } = options;
  if (source.game !== "sr" || kinds.length < 1 || kinds.length > 4 || kinds.some(kind => !Object.hasOwn(routes, kind))) {
    throw new HoyoRequestError("invalid-input", $t("starrail-challenge.text_f1e28e5bcc"));
  }
  const origin = "https://api-takumi-record.mihoyo.com";
  const timeout = AbortSignal.timeout(25_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const interrupted = () => new HoyoRequestError("transport", $t("starrail-challenge.text_83db12b536"));
  async function guard() {
    if (deadline.aborted) throw interrupted();
    await verifyProfile?.();
    if (deadline.aborted) throw interrupted();
  }
  async function request(kind: StarRailChallengeKind, schedule: StarRailChallengePeriod, detailed: boolean) {
    const path = `/game_record/app/hkrpg/api/${routes[kind]}`;
    const endpoint = new URL(path, origin);
    endpoint.searchParams.set("role_id", source.role.uid);
    endpoint.searchParams.set("schedule_type", schedule);
    endpoint.searchParams.set("server", region);
    if (detailed) {
      endpoint.searchParams.set("isPrev", "");
      endpoint.searchParams.set("need_all", "true");
    }
    const headers = requestHeaders(source, source.account.cookie, endpoint.searchParams);
    await guard();
    await addRecordFingerprint(headers, transport, deadline, guard);
    const diagnostics = observeCnRead(path, "GET", signal, timeout);
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await guard();
      try {
        response = await diagnostics.read(() =>
          transport(endpoint, { method: "GET", headers, credentials: "omit", redirect: "error", signal: deadline }));
        if (response.status === 410 && /^text\/html(?:\s*;|$)/iu.test(response.headers.get("Content-Type") ?? "") && attempt < 2) {
          await response.body?.cancel().catch(() => undefined);
          response = undefined;
          await wait(250 * (attempt + 1), undefined, { signal: deadline });
          continue;
        }
        break;
      } catch {
        await guard();
        if (attempt === 2) throw interrupted();
      }
    }
    if (!response) throw interrupted();
    if (response.redirected || (response.url && response.url !== endpoint.href) ||
        (!response.ok && response.status !== 401 && response.status !== 429)) {
      void response.body?.cancel().catch(() => undefined);
      await guard();
      throw new HoyoRequestError("http", $t("starrail-challenge.text_633d6200dd"), response.status);
    }
    const aigis = response.headers.get("x-rpc-aigis")?.trim();
    const challenge = Boolean(aigis && aigis !== "{}");
    if (challenge || response.status === 429) {
      void response.body?.cancel().catch(() => undefined);
      await guard();
      throw apiError(response.status, undefined, challenge);
    }
    const payload = await readGameRecordPayload(response, 2 * 1024 * 1024, deadline, error => diagnostics.stream(response, error));
    await guard();
    const retcode = retcodeOf(payload?.retcode);
    if (response.status === 401) throw apiError(response.status, retcode, false);
    if (retcode === undefined) throw new HoyoRequestError("response", $t("starrail-challenge.text_b670c6aa4e"));
    if (retcode !== 0) throw apiError(response.status, retcode, false);
    const data = object(payload?.data);
    if (!data) throw new HoyoRequestError("response", $t("starrail-challenge.text_2f183167d3"));
    verifyResult(data, source.role, region);
    return data;
  }

  const records = [];
  for (const kind of kinds) {
    const schedule: StarRailChallengePeriod = kind === "peak" && period !== "current" ? "3" : period === "last" ? "2" : "1";
    if (!simple) {
      try {
        records.push({ kind, schedule, simple: false, data: await request(kind, schedule, true) });
        continue;
      } catch (error) {
        if (!(error instanceof ChallengeUnavailable)) throw error;
      }
    }
    records.push({ kind, schedule, simple: true, data: await request(kind, schedule, false) });
  }
  return { records };
}
