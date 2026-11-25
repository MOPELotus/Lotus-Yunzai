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
      expired: `官方${subject}的 Cookie 已失效。`,
      risk: `官方${subject}要求验证，请在官方客户端处理后重试。`,
      "rate-limited": `官方${subject}请求过于频繁，请稍后重试。`,
      account: `米游社账号异常，暂时无法查询${subject.replace(/查询$/u, "")}。`,
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

function requestHeaders(source: ProfileRequestContext, query: string, body?: string): Headers {
  const { account, device } = source;
  const cookie = account.cookie.trim();
  const valid = (value: string) => !/[^\x20-\x7E]/u.test(value);
  if (!cookie.includes("=") || !valid(account.cookie) || !valid(device.id ?? "") || !valid(device.fp ?? "")) {
    throw new HoyoRequestError("invalid-input", "当前档案的 Cookie 或设备字段无效。");
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

function apiError(payload: Json | undefined, status: number, retcode: number | undefined, label: string): HoyoRequestError {
  const message = [payload?.message, payload?.msg, object(payload?.data)?.message].find((item) => typeof item === "string") ?? "";
  const code = status === 401 || status === 429 ? "http" : "api";
  const subject = `${label}查询`;
  if (status === 429) return new GameRecordRequestError(subject, "rate-limited", code, status, retcode);
  if (retcode === 10041) return new GameRecordRequestError(subject, "account", code, status, retcode);
  if ((retcode !== undefined && riskCodes.has(retcode)) || /验证码|captcha|geetest|challenge|风控/iu.test(String(message))) {
    return new GameRecordRequestError(subject, "risk", code, status, retcode);
  }
  if (/visit too frequently|too frequent|rate limit|频繁/iu.test(String(message))) return new GameRecordRequestError(subject, "rate-limited", code, status, retcode);
  if (status === 401 || (retcode !== undefined && expiredCodes.has(retcode))) return new GameRecordRequestError(subject, "expired", code, status, retcode);
  return new HoyoRequestError("api", `官方${label}接口拒绝请求。`, status, retcode);
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
  const label = forNote ? "体力" : genshinMonthly ? "原石札记" : zzzPanelDetail ? "绝区零面板" : kind === "zzz-holo-boss" ? "拟境湮灭战" :
    kind === "zzz-void-front" ? "临界推演" : climbingTower ? "拟真鏖战试炼" :
    hollow ? (hollowLost ? "零号空洞：迷失之地" : "零号空洞：枯萎苗圃") : zenkov ? "迷宫诡域" : exploration ? "绝区零区域收集" : zzzMonthly ? "绝区零月报" : kind === "zzz-owned-buddy" ? "绝区零邦布" : forZzz ? "绝区零战绩" :
    starRailRogue ? "星铁宇宙战绩" : starRailGridFight ? "货币战争战绩" : starRailMonthly ? "星铁月收入" : starRailRoster ? "星铁角色名册" : starRailPanel ? "星铁面板" : hardChallenge ? "幽境危战" : forGenshinChallenge ? (kind === "genshin-abyss" ? "深境螺旋" : "幻想真境剧诗") : forGenshinPanel ? "原神面板" : forDeck ? "七圣召唤牌组" : forGcgCards ? "七圣召唤收藏" : "原神战绩";
  const subject = `${label}查询`;
  const route = Object.hasOwn(records, game) ? records[game] : undefined;
  const savedRegion = isUnspecifiedCnRecordRegion(source.role.region) ? "" : source.role.region.trim();
  const region = game === "gs" ? genshinCnRecordRegion(source.role) :
    savedRegion || route?.regions[game !== "zzz" && uid.startsWith("5") ? 1 : 0];
  if ((!forNote && game !== (forZzz ? "zzz" : forStarRail ? "sr" : "gs")) || !route?.uid.test(uid) || !region || !route.regions.includes(region) || (gameBiz && gameBiz !== route.gameBiz) ||
      (game !== "zzz" && uid.startsWith("5") !== (region === route.regions[1]))) {
    throw new HoyoRequestError("invalid-input", `${subject}仅支持档案中已确认的国服游戏角色和区服。`);
  }
  if ((starRailMonthly || starRailGridFight || starRailRogue) && (!savedRegion || !gameBiz.trim())) {
    throw new HoyoRequestError("invalid-input", `${label}需使用档案中已同步的国服角色。`);
  }
  if ((starRailMonthly || starRailGridFight || starRailRogue) && !source.device.id?.trim()) {
    throw new HoyoRequestError("invalid-input", `当前档案缺少设备 ID，请重新扫码登录后查询${label}。`);
  }
  if (options.kind === "genshin-panel-detail" && (!Array.isArray(options.characterIds) || !options.characterIds.length ||
      options.characterIds.length > 256 || options.characterIds.some(id => !Number.isSafeInteger(id) || id < 1))) {
    throw new HoyoRequestError("invalid-input", "原神面板角色编号无效。");
  }
  if (zzzPanelDetail && (!Number.isSafeInteger(options.characterId) || options.characterId < 1)) {
    throw new HoyoRequestError("invalid-input", "绝区零面板代理人编号无效。");
  }
  if (genshinMonthly && (!Number.isInteger(options.month) || options.month < 1 || options.month > 12)) {
    throw new HoyoRequestError("invalid-input", "原石札记月份无效。");
  }
  if (options.kind === "starrail-monthly" && options.month !== undefined &&
      (!/^20\d{2}(?:0[1-9]|1[0-2])$/u.test(options.month) || options.month < "202304")) {
    throw new HoyoRequestError("invalid-input", "星铁月收入月份无效。");
  }
  const regionalPeriod = options.kind === "zzz-deadly" || options.kind === "zzz-holo-boss" || options.kind === "zzz-void-front";
  const zzzPeriod = options.kind === "zzz-hadal" || regionalPeriod;
  const usesRegion = regionalPeriod || climbingTower || hollowLost || zenkov || exploration || monthly;
  if (zzzPeriod && options.scheduleType !== 1 && options.scheduleType !== 2) {
    throw new HoyoRequestError("invalid-input", "绝区零战绩查询期次无效。");
  }
  if (kind === "genshin-abyss" && options.scheduleType !== 1 && options.scheduleType !== 2) {
    throw new HoyoRequestError("invalid-input", "深境螺旋查询期次无效。");
  }
  if (kind === "starrail-rogue" && options.scheduleType !== 1 && options.scheduleType !== 2) {
    throw new HoyoRequestError("invalid-input", "模拟宇宙查询期次无效。");
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
  const endpoint = new URL(path, genshinMonthly ? "https://hk4e-api.mihoyo.com" : monthly ? "https://api-takumi.mihoyo.com" : origin);
  let body: string | undefined;
  if (forGenshinPanel) {
    body = JSON.stringify({ role_id: uid, server: region,
      ...(options.kind === "genshin-panel-detail" && { character_ids: options.characterIds }) });
  } else if (genshinMonthly) {
    endpoint.searchParams.set("month", String(options.month));
    endpoint.searchParams.set("bind_uid", uid);
    endpoint.searchParams.set("bind_region", region);
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
  const headers = requestHeaders(source, endpoint.search.slice(1), body);
  // The signed query for this route ends at need_wiki. The selected ID is appended afterward.
  if (zzzPanelDetail) endpoint.searchParams.set("id_list[]", String(options.characterId));
  if (starRailMonthly) headers.set("Origin", "https://webstatic.mihoyo.com");
  // The ZZZ ledger signs the role query before adding the selected month.
  if (zzzMonthly) {
    endpoint.searchParams.set("month", options.month);
    headers.set("Origin", "https://act.mihoyo.com");
    headers.set("Referer", "https://act.mihoyo.com/");
    headers.set("x-requested-with", "com.mihoyo.hyperion");
  }

  async function guard() {
    if (signal?.aborted) throw new HoyoRequestError("transport", `${subject}已取消。`);
    await verifyProfile?.();
    if (signal?.aborted) throw new HoyoRequestError("transport", `${subject}已取消。`);
  }

  await guard();
  const timeout = AbortSignal.timeout(15_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  await addRecordFingerprint(headers, transport, deadline, guard);
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
      if (deadline.aborted || attempt === 2) throw new HoyoRequestError("transport", `官方${subject}请求未完成。`);
    }
  }
  if (!response) throw new HoyoRequestError("transport", `官方${subject}请求未完成。`);
  if (response.redirected || (response.url && response.url !== endpoint.href) ||
      (!response.ok && response.status !== 401 && response.status !== 429)) {
    await response.body?.cancel().catch(() => undefined);
    throw new HoyoRequestError("http", `官方${label}接口返回 HTTP 错误。`, response.status);
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
  if (deadline.aborted) throw new HoyoRequestError("transport", `官方${subject}请求未完成。`);
  const retcode = whole(payload?.retcode);
  if (response.status === 401) throw apiError(payload, response.status, retcode, label);
  if (retcode === undefined) throw new HoyoRequestError("response", `官方${label}响应格式无效。`);
  if (starRailPanel && retcode === 10102) throw new HoyoRequestError("api", "星铁面板数据未公开或未绑定角色。", response.status, retcode);
  if (retcode !== 0) throw apiError(payload, response.status, retcode, label);
  const data = (starRailGridFight || starRailRogue || climbingTower || hollow || zenkov || exploration || monthly || kind === "genshin-gcg-collection-summary") && payload?.data === null ? {} : object(payload?.data);
  if (!data) throw new HoyoRequestError("response", `官方${label}响应缺少有效数据。`);
  return { data, region };
}
