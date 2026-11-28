import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import { createHash, randomInt } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { transientReadResponse } from "@lotus-yunzai/http";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { observeCnRead } from "./cn-read-diagnostics.ts";
import { addRecordFingerprint } from "./record-fingerprint.ts";

export class GameRecordRequestError extends HoyoRequestError {
  constructor(subject: string, readonly reason: "expired" | "risk" | "rate-limited" | "account",
    code: "api" | "http", status: number, retcode?: number) {
    super(code, {
      expired: $t("game-record.text_6b92956648", { "subject": subject }),
      risk: $t("game-record.text_df1d8641e0", { "subject": subject }),
      "rate-limited": $t("game-record.text_99b53fb45b", { "subject": subject }),
      account: $t("game-record.text_a00ef87f25", { "value1": subject.replace(/查询$/u, "") }),
    }[reason], status, retcode);
  }
}

export function isGameRecordCookieExpired(error: unknown): boolean {
  return error instanceof GameRecordRequestError && error.reason === "expired";
}

const origin = "https://api-takumi-record.mihoyo.com";
const appVersion = "2.118.1";
const signingSalt = "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";
const records = {
  gs: { path: "/game_record/app/genshin/api/dailyNote", gameBiz: "hk4e_cn", regions: ["cn_gf01", "cn_qd01"], uid: /^[1-5]\d{8}$/u },
  sr: { path: "/game_record/app/hkrpg/api/note", gameBiz: "hkrpg_cn", regions: ["prod_gf_cn", "prod_qd_cn"], uid: /^[1-5]\d{8}$/u },
  zzz: { path: "/event/game_record_zzz/api/zzz/note", gameBiz: "nap_cn", regions: ["prod_gf_cn", "prod_qd_cn"], uid: /^[1-9]\d{7,8}$/u },
};
const unspecifiedRegion = new Set(["", "unknown", "undefined", "null", "none", "-"]);
const expiredCodes = new Set([-100, 10001, 10101, 10102, 10103]);
const riskCodes = new Set([1034, 10035]);
const zzzCardPaths = {
  "zzz-index": "index",
  "zzz-avatar": "avatar/basic",
  "zzz-panel-detail": "avatar/info",
  "zzz-buddy": "buddy/info",
  "zzz-owned-buddy": "buddy/info",
  "zzz-hadal": "hadal_info_v2",
  "zzz-deadly": "hadal_mem_detail_v2",
  "zzz-holo-boss": "holo_boss_detail",
  "zzz-void-front": "void_front_battle_period_detail",
  "zzz-climbing-tower": "climbing_tower_detail",
  "zzz-hollow-abstract": "abyss_abstract",
  "zzz-hollow-detail": "abyss_detail",
  "zzz-hollow-lost": "abysss2_abstract",
  "zzz-zenkov": "zenkov_abstract_info",
  "zzz-zenkov-detail": "zenkov_detail",
  "zzz-exploration": "exploration_detail",
} as const;
const genshinPanelPaths = {
  "genshin-panel-list": "character/list",
  "genshin-panel-detail": "character/detail",
} as const;
type ZzzPeriodRecord = "zzz-hadal" | "zzz-deadly" | "zzz-holo-boss" | "zzz-void-front";
type RecordOptions = { readonly signal?: AbortSignal } & (
  { readonly kind: "daily-note" | "genshin-index" | "genshin-gcg-deck" | "genshin-gcg-collection-summary" | "starrail-avatar-info" | "starrail-index" | "starrail-avatar-basic" | "starrail-grid-fight" | "genshin-panel-list" |
    Exclude<keyof typeof zzzCardPaths, ZzzPeriodRecord | "zzz-panel-detail"> } |
  { readonly kind: "genshin-abyss"; readonly scheduleType: 1 | 2 } |
  { readonly kind: "starrail-rogue"; readonly scheduleType: 1 | 2 } |
  { readonly kind: "starrail-rogue-locust" | "starrail-rogue-tourn" } |
  { readonly kind: "genshin-theater" } |
  { readonly kind: "genshin-hard-challenge" | "genshin-hard-popularity" } |
  { readonly kind: "genshin-monthly"; readonly month: number } |
  { readonly kind: "starrail-monthly"; readonly month?: string } |
  { readonly kind: "genshin-gcg-cards"; readonly collection: "character" | "action" } |
  { readonly kind: "genshin-panel-detail"; readonly characterIds: readonly number[] } |
  { readonly kind: "zzz-panel-detail"; readonly characterId: number } |
  { readonly kind: "zzz-monthly"; readonly month: string } |
  { readonly kind: ZzzPeriodRecord; readonly scheduleType: 1 | 2 }
);
type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function whole(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^-?\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof parsed === "number" && Number.isSafeInteger(parsed)) return parsed;
}

export function gameRecordHeaders(source: ProfileRequestContext, query: string, body?: string, includePassport = false): Headers {
  const { account, device } = source;
  if (source.international) {
    const { cookie, language, deviceId } = source.international;
    if (!cookie || /[^\x20-\x7e]/u.test(cookie) || !/^[A-Za-z_-]{1,32}$/u.test(language) || /[^A-Za-z0-9_-]/u.test(deviceId)) {
      throw new HoyoRequestError("invalid-input", $t("game-record.text_aea96e3b9b"));
    }
    const time = Math.floor(Date.now() / 1000), nonce = randomInt(100000, 1000000).toString();
    const hash = createHash("md5").update(`salt=6s25p5ox5y14umn1p61aqyyvbvvl3lrt&t=${time}&r=${nonce}`).digest("hex");
    return new Headers({ Accept: "application/json", Cookie: includePassport ? `${cookie}; ${source.international.passportCookie}` : cookie, Origin: "https://act.hoyolab.com", Referer: "https://act.hoyolab.com/",
      "User-Agent": "Mozilla/5.0 HoYoLAB/1.5.0", "x-rpc-app_version": "1.5.0", "x-rpc-client_type": "5",
      "x-rpc-language": language, "x-rpc-lang": language, ...(deviceId && { "x-rpc-device_id": deviceId }),
      DS: `${time},${nonce},${hash}`, ...(body !== undefined && { "Content-Type": "application/json" }) });
  }
  const cookie = account.cookie.trim();
  const valid = (value: string) => !/[^\x20-\x7E]/u.test(value);
  if (!cookie.includes("=") || !valid(account.cookie) || !valid(device.id ?? "") || !valid(device.fp ?? "")) {
    throw new HoyoRequestError("invalid-input", $t("game-record.text_aea96e3b9b"));
  }
  const time = Math.round(Date.now() / 1000);
  const nonce = randomInt(100000, 1000000);
  const hash = createHash("md5").update(`salt=${signingSalt}&t=${time}&r=${nonce}&b=${body ?? ""}&q=${query}`).digest("hex");
  const model = device.model && valid(device.model) ? device.model : "Android";
  const android = device.androidVersion && /^\d{1,2}(?:\.\d+){0,2}$/u.test(device.androidVersion) ? device.androidVersion : "12";
  const headers = new Headers({ Accept: "application/json", Cookie: cookie,
    "User-Agent": `Mozilla/5.0 (Linux; Android ${android}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 miHoYoBBS/${appVersion}`,
    "x-rpc-app_version": appVersion, "x-rpc-client_type": "5", Referer: "https://webstatic.mihoyo.com/",
    DS: `${time},${nonce},${hash}`,
  });
  if (device.id) headers.set("x-rpc-device_id", device.id);
  if (device.id && device.fp) headers.set("x-rpc-device_fp", device.fp);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return headers;
}

export async function readGameRecordPayload(response: Response, limit: number, signal: AbortSignal,
  onStreamFailure?: (reason: unknown) => unknown): Promise<Json | undefined> {
  if (!response.body) return;
  if (Number(response.headers.get("Content-Length")) > limit) {
    await response.body.cancel().catch(() => undefined);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read().catch((error: unknown) => {
        try {
          void Promise.resolve(onStreamFailure?.(error)).catch(() => undefined);
        } catch {
          // Only the existing response error is visible to the caller.
        }
        throw error;
      });
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) return;
      text += decoder.decode(next.value, { stream: true });
    }
    return object(JSON.parse(text + decoder.decode()));
  } catch {
    return;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function apiError(payload: Json | undefined, status: number, retcode: number | undefined, label: string, overseas = false): HoyoRequestError {
  if (overseas && retcode === 10102) return new HoyoRequestError("api", $t("hoyolab-authkey.privacy", { subject: label }), status, retcode);
  const message = [payload?.message, payload?.msg, object(payload?.data)?.message].find((item) => typeof item === "string") ?? "";
  const code = status === 401 || status === 429 ? "http" : "api";
  const subject = $t("game-record.text_7c6d31e82d", { "label": label });
  if (status === 429 || overseas && retcode === 10101) return new GameRecordRequestError(subject, "rate-limited", code, status, retcode);
  if (retcode === 10041) return new GameRecordRequestError(subject, "account", code, status, retcode);
  if ((retcode !== undefined && riskCodes.has(retcode)) || /验证码|captcha|geetest|challenge|风控/iu.test(String(message))) {
    return new GameRecordRequestError(subject, "risk", code, status, retcode);
  }
  if (/visit too frequently|too frequent|rate limit|频繁/iu.test(String(message))) return new GameRecordRequestError(subject, "rate-limited", code, status, retcode);
  if (status === 401 || (retcode !== undefined && (overseas ? [-100, 10001, 10103].includes(retcode) : expiredCodes.has(retcode)))) return new GameRecordRequestError(subject, "expired", code, status, retcode);
  return new HoyoRequestError("api", $t("game-record.text_b28f638e75", { "label": label }), status, retcode);
}

export function isUnspecifiedCnRecordRegion(region: string): boolean {
  return unspecifiedRegion.has(region.trim().toLowerCase());
}

export function genshinCnRecordRegion({ uid, region, gameBiz }: ProfileRequestContext["role"]) {
  if (!records.gs.uid.test(uid) || (gameBiz && gameBiz !== records.gs.gameBiz)) return;
  const expected = uid.startsWith("5") ? "cn_qd01" : "cn_gf01";
  const savedRegion = region.trim();
  if (savedRegion === expected || (isUnspecifiedCnRecordRegion(savedRegion) && /^[125]\d{8}$/u.test(uid))) return expected;
}

export async function readCnGameRecord(source: ProfileRequestContext, transport: HoyoTransport,
  options: RecordOptions,
  verifyProfile?: () => Promise<void>) {
  const { kind, signal } = options;
  const { game, role: { uid, gameBiz } } = source;
  const forNote = kind === "daily-note";
  const starRailPanel = kind === "starrail-avatar-info";
  const starRailMonthly = kind === "starrail-monthly";
  const starRailRoster = kind === "starrail-index" || kind === "starrail-avatar-basic";
  const starRailGridFight = kind === "starrail-grid-fight";
  const starRailRogue = kind === "starrail-rogue" || kind === "starrail-rogue-locust" || kind === "starrail-rogue-tourn";
  const forStarRail = starRailPanel || starRailMonthly || starRailRoster || starRailGridFight || starRailRogue;
  const genshinMonthly = kind === "genshin-monthly";
  const forDeck = kind === "genshin-gcg-deck";
  const forGcgCards = kind === "genshin-gcg-cards" || kind === "genshin-gcg-collection-summary";
  const forGenshinChallenge = kind === "genshin-abyss" || kind === "genshin-theater";
  const hardChallenge = kind === "genshin-hard-challenge" || kind === "genshin-hard-popularity";
  const forGenshinPanel = kind === "genshin-panel-list" || kind === "genshin-panel-detail";
  const zzzPanelDetail = kind === "zzz-panel-detail";
  const climbingTower = kind === "zzz-climbing-tower";
  const hollowLost = kind === "zzz-hollow-lost";
  const hollowDetail = kind === "zzz-hollow-detail";
  const hollow = hollowLost || hollowDetail || kind === "zzz-hollow-abstract";
  const zenkov = kind === "zzz-zenkov" || kind === "zzz-zenkov-detail";
  const exploration = kind === "zzz-exploration";
  const zzzMonthly = kind === "zzz-monthly";
  const monthly = zzzMonthly || starRailMonthly || genshinMonthly;
  const forZzz = zzzMonthly || Object.hasOwn(zzzCardPaths, kind);
  const label = forNote ? $t("game-record.text_d6d2aa99fd") : genshinMonthly ? $t("game-record.text_68bc8c9666") : zzzPanelDetail ? $t("game-record.text_ce4af56042") : kind === "zzz-holo-boss" ? $t("game-record.text_29e80a0630") :
    kind === "zzz-void-front" ? $t("game-record.text_86bf7c9458") : climbingTower ? $t("game-record.text_16a75e0027") :
    hollow ? (hollowLost ? $t("game-record.text_fc57224a51") : $t("game-record.text_e865364b94")) : zenkov ? $t("game-record.text_0a991a8e6c") : exploration ? $t("game-record.text_ad3b2b17cf") : zzzMonthly ? $t("game-record.text_2551c3eb77") : kind === "zzz-owned-buddy" ? $t("game-record.text_42a387e33f") : forZzz ? $t("game-record.text_341ac2816f") :
    starRailRogue ? $t("game-record.text_c0ef333bd0") : starRailGridFight ? $t("game-record.text_6bb5243e98") : starRailMonthly ? $t("game-record.text_92f4941f67") : starRailRoster ? $t("game-record.text_f61cd5e41f") : starRailPanel ? $t("game-record.text_6ce5363a7d") : hardChallenge ? $t("game-record.text_c3354e0ec8") : forGenshinChallenge ? (kind === "genshin-abyss" ? $t("game-record.text_82f72c6585") : $t("game-record.text_8cb870ae6a")) : forGenshinPanel ? $t("game-record.text_0b3ee04b94") : forDeck ? $t("game-record.text_fa0be28724") : forGcgCards ? $t("game-record.text_b25bca67a8") : $t("game-record.text_a2a4c50077");
  const subject = $t("game-record.text_7c6d31e82d", { "label": label });
  const overseas = source.international;
  const overseasRoutes = {
    gs: { path: "/event/game_record/genshin/api/dailyNote", gameBiz: "hk4e_global", regions: ["os_usa", "os_euro", "os_asia", "os_cht"], uid: /^[1-9]\d{8,9}$/u },
    sr: { path: "/game_record/hkrpg/api/note", gameBiz: "hkrpg_global", regions: ["prod_official_usa", "prod_official_eur", "prod_official_asia", "prod_official_cht"], uid: /^[1-9]\d{8,9}$/u },
    zzz: { path: "/event/game_record_zzz/api/zzz/note", gameBiz: "nap_global", regions: ["prod_gf_us", "prod_gf_eu", "prod_gf_jp", "prod_gf_sg"], uid: /^[1-9]\d{7,9}$/u },
  };
  const routes = overseas ? overseasRoutes : records;
  const route = Object.hasOwn(routes, game) ? routes[game] : undefined;
  const savedRegion = isUnspecifiedCnRecordRegion(source.role.region) ? "" : source.role.region.trim();
  const region = overseas ? savedRegion : game === "gs" ? genshinCnRecordRegion(source.role) :
    savedRegion || route?.regions[game !== "zzz" && uid.startsWith("5") ? 1 : 0];
  if ((!forNote && game !== (forZzz ? "zzz" : forStarRail ? "sr" : "gs")) || !route?.uid.test(uid) || !region || !route.regions.includes(region) || (gameBiz && gameBiz !== route.gameBiz) ||
      (!overseas && game !== "zzz" && uid.startsWith("5") !== (region === route.regions[1]))) {
    throw new HoyoRequestError("invalid-input", $t("game-record.text_e03f7c80cf", { "subject": subject }));
  }
  if ((starRailMonthly || starRailGridFight || starRailRogue) && (!savedRegion || !gameBiz.trim())) {
    throw new HoyoRequestError("invalid-input", $t("game-record.text_9a2fe7ac88", { "label": label }));
  }
  if ((starRailMonthly || starRailGridFight || starRailRogue) && !source.device.id?.trim() && !overseas?.deviceId) {
    throw new HoyoRequestError("invalid-input", $t("game-record.text_20c322406a", { "label": label }));
  }
  if (options.kind === "genshin-panel-detail" && (!Array.isArray(options.characterIds) || !options.characterIds.length ||
      options.characterIds.length > 256 || options.characterIds.some(id => !Number.isSafeInteger(id) || id < 1))) {
    throw new HoyoRequestError("invalid-input", $t("game-record.text_974ea07349"));
  }
  if (zzzPanelDetail && (!Number.isSafeInteger(options.characterId) || options.characterId < 1)) {
    throw new HoyoRequestError("invalid-input", $t("game-record.text_6cc7ff1ae6"));
  }
  if (genshinMonthly && (!Number.isInteger(options.month) || options.month < 1 || options.month > 12)) {
    throw new HoyoRequestError("invalid-input", $t("game-record.text_e7cfad0439"));
  }
  if (options.kind === "starrail-monthly" && options.month !== undefined &&
      (!/^20\d{2}(?:0[1-9]|1[0-2])$/u.test(options.month) || options.month < "202304")) {
    throw new HoyoRequestError("invalid-input", $t("game-record.text_7121d16ea8"));
  }
  const regionalPeriod = options.kind === "zzz-deadly" || options.kind === "zzz-holo-boss" || options.kind === "zzz-void-front";
  const zzzPeriod = options.kind === "zzz-hadal" || regionalPeriod;
  const usesRegion = regionalPeriod || climbingTower || hollowLost || zenkov || exploration || monthly;
  if (zzzPeriod && options.scheduleType !== 1 && options.scheduleType !== 2) {
    throw new HoyoRequestError("invalid-input", $t("game-record.text_3cfdf51fa0"));
  }
  if (kind === "genshin-abyss" && options.scheduleType !== 1 && options.scheduleType !== 2) {
    throw new HoyoRequestError("invalid-input", $t("game-record.text_f30a132c32"));
  }
  if (kind === "starrail-rogue" && options.scheduleType !== 1 && options.scheduleType !== 2) {
    throw new HoyoRequestError("invalid-input", $t("game-record.text_291200ede8"));
  }
  const path = forNote ? route.path : starRailPanel ? "/game_record/app/hkrpg/api/avatar/info"
    : starRailGridFight ? "/game_record/app/hkrpg/api/grid_fight"
    : starRailRogue ? `/game_record/app/hkrpg/api/${kind === "starrail-rogue" ? "rogue" : kind === "starrail-rogue-locust" ? "rogue_locust" : "rogue_tourn"}`
    : starRailRoster ? `/game_record/app/hkrpg/api/${kind === "starrail-index" ? "index" : "avatar/basic"}`
    : forGenshinPanel ? `/game_record/app/genshin/api/${genshinPanelPaths[kind]}`
    : genshinMonthly ? "/event/ys_ledger/monthInfo" : starRailMonthly ? "/event/srledger/month_info" : zzzMonthly ? "/event/nap_ledger/month_info"
    : forZzz ? `/event/game_record_zzz/api/zzz/${zzzCardPaths[kind as keyof typeof zzzCardPaths]}`
    : forDeck ? "/game_record/app/genshin/api/gcg/deckList"
    : forGcgCards ? `/game_record/app/genshin/api/gcg/${kind === "genshin-gcg-cards" ? "cardList" : "basicInfo"}`
    : hardChallenge ? `/game_record/app/genshin/api/hard_challenge${kind === "genshin-hard-popularity" ? "/popularity" : ""}`
    : forGenshinChallenge ? `/game_record/app/genshin/api/${kind === "genshin-abyss" ? "spiralAbyss" : "role_combat"}`
    : "/game_record/app/genshin/api/index";
  const overseasOrigin = game === "gs" ? "https://sg-public-api.hoyolab.com" : game === "sr" ? "https://bbs-api-os.hoyolab.com" : "https://sg-act-public-api.hoyolab.com";
  const overseasPath = genshinMonthly ? "/event/ysledgeros/month_info" : path.replace("/game_record/app/genshin/api/", "/event/game_record/genshin/api/").replace("/game_record/app/hkrpg/api/", "/game_record/hkrpg/api/");
  const endpoint = new URL(overseas ? overseasPath : path, overseas
    ? genshinMonthly ? "https://sg-hk4e-api.hoyolab.com" : monthly ? "https://sg-public-api.hoyolab.com" : overseasOrigin
    : genshinMonthly ? "https://hk4e-api.mihoyo.com" : monthly ? "https://api-takumi.mihoyo.com" : origin);
  let body: string | undefined;
  if (forGenshinPanel) {
    body = JSON.stringify({ role_id: uid, server: region,
      ...(options.kind === "genshin-panel-detail" && { character_ids: options.characterIds }) });
  } else if (genshinMonthly) {
    endpoint.searchParams.set("month", String(options.month));
    endpoint.searchParams.set(overseas ? "uid" : "bind_uid", uid);
    endpoint.searchParams.set(overseas ? "region" : "bind_region", region);
    if (overseas) endpoint.searchParams.set("lang", overseas.language);
  } else {
    if ((forZzz && !exploration && !zzzMonthly && kind !== "zzz-owned-buddy") || starRailMonthly) endpoint.searchParams.set("lang", "zh-cn");
    if (starRailPanel) endpoint.searchParams.set("need_wiki", "true");
    if (options.kind === "genshin-gcg-cards") {
      endpoint.searchParams.set("limit", "999");
      endpoint.searchParams.set("need_action", String(options.collection === "action"));
      endpoint.searchParams.set("need_avatar", String(options.collection === "character"));
      endpoint.searchParams.set("need_stats", "true");
      endpoint.searchParams.set("offset", "0");
    }
    if (starRailRogue) endpoint.searchParams.set("need_detail", "true");
    endpoint.searchParams.set(usesRegion ? "uid" : "role_id", uid);
    if (options.kind === "genshin-abyss" || options.kind === "starrail-rogue") endpoint.searchParams.set("schedule_type", String(options.scheduleType));
    if (kind === "genshin-theater" || kind === "genshin-hard-challenge") endpoint.searchParams.set("need_detail", "true");
    endpoint.searchParams.set(usesRegion ? "region" : "server", region);
    if (zzzPeriod) endpoint.searchParams.set("schedule_type", String(options.scheduleType));
    if (zzzPanelDetail) endpoint.searchParams.set("need_wiki", "false");
    if (hollowDetail) endpoint.searchParams.set("type", "3");
    if (options.kind === "starrail-monthly") endpoint.searchParams.set("month", options.month ?? "");
  }
  const headers = gameRecordHeaders(source, endpoint.search.slice(1), body, monthly);
  // The signed query for this route ends at need_wiki. The selected ID is appended afterward.
  if (zzzPanelDetail) endpoint.searchParams.set("id_list[]", String(options.characterId));
  if (starRailMonthly && !overseas) headers.set("Origin", "https://webstatic.mihoyo.com");
  // The ZZZ ledger signs the role query before adding the selected month.
  if (zzzMonthly) {
    endpoint.searchParams.set("month", options.month);
    if (!overseas) {
      headers.set("Origin", "https://act.mihoyo.com"); headers.set("Referer", "https://act.mihoyo.com/");
      headers.set("x-requested-with", "com.mihoyo.hyperion");
    }
  }

  async function guard() {
    if (signal?.aborted) throw new HoyoRequestError("transport", $t("game-record.text_e081ffda7d", { "subject": subject }));
    await verifyProfile?.();
    if (signal?.aborted) throw new HoyoRequestError("transport", $t("game-record.text_e081ffda7d", { "subject": subject }));
  }

  await guard();
  const timeout = AbortSignal.timeout(15_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (!overseas) await addRecordFingerprint(headers, transport, deadline, guard);
  const method = body === undefined ? "GET" : "POST";
  const diagnostics = observeCnRead(path, method, signal, timeout);
  let response: Response | undefined;
  // Every registered route here is a reader, including POST character/detail.
  // Retrying a lost connection cannot repeat a sign-in, exchange or other write.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await guard();
    try {
      response = await diagnostics.read(() => transport(endpoint, {
        method, body, headers, credentials: "omit", redirect: "error", signal: deadline, readRetry: false,
      }));
      if (transientReadResponse(response) && !response.redirected && attempt < 2) {
        await response.body?.cancel().catch(() => undefined);
        response = undefined;
        await wait(250 * (attempt + 1), undefined, { signal: deadline });
        continue;
      }
      break;
    } catch {
      await guard();
      if (deadline.aborted || attempt === 2) throw new HoyoRequestError("transport", $t("game-record.text_c0f09da0e9", { "subject": subject }));
    }
  }
  if (!response) throw new HoyoRequestError("transport", $t("game-record.text_c0f09da0e9", { "subject": subject }));
  if (response.redirected || (response.url && response.url !== endpoint.href) ||
      (!response.ok && response.status !== 401 && response.status !== 429)) {
    await response.body?.cancel().catch(() => undefined);
    throw new HoyoRequestError("http", $t("game-record.text_7a715ff587", { "label": label }), response.status);
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw apiError(undefined, response.status, undefined, label);
  }
  if (forStarRail || forGenshinPanel || forGenshinChallenge || hardChallenge || forDeck || forGcgCards || zzzPanelDetail || zzzPeriod || climbingTower || hollow || zenkov || exploration || monthly || kind === "zzz-avatar") {
    const aigis = response.headers.get("x-rpc-aigis")?.trim();
    if (aigis && aigis !== "{}") {
      await response.body?.cancel().catch(() => undefined);
      await guard();
      throw new GameRecordRequestError(subject, "risk", "api", response.status);
    }
  }
  const payload = await readGameRecordPayload(response,
    forNote ? 64 * 1024 : starRailPanel || options.kind === "genshin-panel-detail" ? 8 * 1024 * 1024 : 2 * 1024 * 1024,
    deadline, error => diagnostics.stream(response, error));
  await guard();
  if (deadline.aborted) throw new HoyoRequestError("transport", $t("game-record.text_c0f09da0e9", { "subject": subject }));
  const retcode = whole(payload?.retcode);
  if (response.status === 401) throw apiError(payload, response.status, retcode, label, !!overseas);
  if (retcode === undefined) throw new HoyoRequestError("response", $t("game-record.text_656c331127", { "label": label }));
  if (starRailPanel && retcode === 10102) throw new HoyoRequestError("api", $t("game-record.text_5a0e5f08d5"), response.status, retcode);
  if (retcode !== 0) throw apiError(payload, response.status, retcode, label, !!overseas);
  const data = (starRailGridFight || starRailRogue || climbingTower || hollow || zenkov || exploration || monthly || kind === "genshin-gcg-collection-summary") && payload?.data === null ? {} : object(payload?.data);
  if (!data) throw new HoyoRequestError("response", $t("game-record.text_7dbba95ad1", { "label": label }));
  return { data, region };
}
