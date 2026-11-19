import { createHash, randomInt } from "node:crypto";
import type { Game, ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";

export interface DailyNoteProgress {
  readonly current: number;
  readonly max: number;
}

export interface DailyNoteRecovery extends DailyNoteProgress {
  readonly recoverySeconds?: number;
}

export interface DailyNoteSnapshot {
  readonly game: Game;
  readonly uid: string;
  readonly region: string;
  readonly stamina: DailyNoteRecovery;
  readonly homeCoin?: DailyNoteRecovery;
  readonly commissionRewardReceived?: boolean;
  readonly expeditions?: { readonly current?: number; readonly max?: number; readonly remainingSeconds?: number };
  readonly weeklyDiscount?: DailyNoteProgress;
  readonly transformer?: { readonly ready?: boolean; readonly remainingSeconds?: number };
  readonly training?: DailyNoteProgress;
  readonly rogue?: DailyNoteProgress;
  readonly echoOfWar?: DailyNoteProgress;
  readonly reserveStamina?: number;
  readonly vitality?: DailyNoteProgress;
  readonly videoStore?: "doing" | "done" | "ready" | "idle" | "unknown";
  readonly scratchCardDone?: boolean;
}

export interface DailyNoteOptions {
  readonly signal?: AbortSignal;
}

export class DailyNoteRequestError extends HoyoRequestError {
  constructor(readonly reason: "expired" | "risk" | "rate-limited", code: "api" | "http", status: number, retcode?: number) {
    super(code, {
      expired: "官方体力查询的 Cookie 已失效。",
      risk: "官方体力查询要求验证，请在官方客户端处理后重试。",
      "rate-limited": "官方体力查询请求过于频繁，请稍后重试。",
    }[reason], status, retcode);
  }
}

export function isDailyNoteCookieExpired(error: unknown): boolean {
  return error instanceof DailyNoteRequestError && error.reason === "expired";
}

const origin = "https://api-takumi-record.mihoyo.com";
const appVersion = "2.40.1";
const signingSalt = "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs";
const maxResponseBytes = 64 * 1024;
const records = {
  gs: { path: "/game_record/app/genshin/api/dailyNote", gameBiz: "hk4e_cn", regions: ["cn_gf01", "cn_qd01"], uid: /^[1-5]\d{8}$/u },
  sr: { path: "/game_record/app/hkrpg/api/note", gameBiz: "hkrpg_cn", regions: ["prod_gf_cn", "prod_qd_cn"], uid: /^[1-5]\d{8}$/u },
  zzz: { path: "/event/game_record_zzz/api/zzz/note", gameBiz: "nap_cn", regions: ["prod_gf_cn", "prod_qd_cn"], uid: /^[1-9]\d{7,8}$/u },
};
const expiredCodes = new Set([-100, 10001, 10101, 10102, 10103]);
const riskCodes = new Set([1034, 10035, 10041]);
type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
}

function whole(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^-?\d{1,16}$/u.test(value) ? Number(value) : value;
  if (typeof parsed === "number" && Number.isSafeInteger(parsed)) return parsed;
}

function uint(value: unknown): number | undefined {
  const num = whole(value);
  if (num !== undefined && num >= 0) return num;
}

function flag(value: unknown): boolean | undefined {
  if (value === true || value === "1" || value === 1) return true;
  if (value === false || value === "0" || value === 0) return false;
}

function progress(current: unknown, max: unknown): DailyNoteProgress | undefined {
  const amount = uint(current);
  const capacity = uint(max);
  if (amount !== undefined && capacity !== undefined) return { current: amount, max: capacity };
}

function recovery(current: unknown, max: unknown, duration?: unknown): DailyNoteRecovery | undefined {
  const value = progress(current, max);
  if (!value?.max) return;
  const recoverySeconds = uint(duration);
  return { ...value, ...(recoverySeconds === undefined ? {} : { recoverySeconds }) };
}

function parseExpeditions(data: Json, game: "gs" | "sr"): DailyNoteSnapshot["expeditions"] {
  const list = Array.isArray(data.expeditions) ? data.expeditions.map(object).filter((row) => row !== undefined) : undefined;
  const active = list?.filter((row) => {
    const status = row.status ?? row.state;
    if (typeof status === "string" && /^(?:none|idle|empty|未派遣)$/iu.test(status)) return false;
    return uint(row.remaining_time ?? row.remained_time ?? row.remain_time ?? row.left_time) !== undefined ||
      (typeof status === "string" && status.length > 0) || (Array.isArray(row.avatars) && row.avatars.length > 0);
  });
  const inferred = list?.length ? active?.length : undefined;
  const current = uint(game === "sr" ? data.accepted_expedition_num ?? data.accepted_epedition_num ?? data.current_expedition_num
    : data.current_expedition_num) ?? inferred;
  const max = uint(game === "sr" ? data.total_expedition_num ?? data.max_expedition_num : data.max_expedition_num)
    ?? (list?.length || undefined);
  let remainingSeconds: number | undefined;
  for (const row of active ?? []) {
    const left = uint(row.remaining_time ?? row.remained_time ?? row.remain_time ?? row.left_time);
    if (left !== undefined) remainingSeconds = Math.min(remainingSeconds ?? left, left);
  }
  if (current !== undefined || max !== undefined || remainingSeconds !== undefined) return {
    ...(current === undefined ? {} : { current }), ...(max === undefined ? {} : { max }),
    ...(remainingSeconds === undefined ? {} : { remainingSeconds }),
  };
}

function weeklyDiscount(data: Json): DailyNoteProgress | undefined {
  const remaining = uint(data.remain_resin_discount_num);
  const max = uint(data.resin_discount_num_limit);
  if (remaining !== undefined && max !== undefined && remaining <= max) return { current: max - remaining, max };
}

function parseTransformer(value: unknown): DailyNoteSnapshot["transformer"] {
  const target = object(value);
  if (!target || flag(target.obtained) !== true) return;
  const time = object(target.recovery_time);
  const ready = flag(target.reached) === true || flag(time?.reached) === true ? true
    : flag(target.reached) ?? flag(time?.reached);
  const days = uint(time?.Day);
  const hours = uint(time?.Hour);
  const minutes = uint(time?.Minute);
  const seconds = uint(time?.Second);
  const duration = (days ?? 0) * 86400 + (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
  const hasDuration = (days !== undefined || hours !== undefined || minutes !== undefined || seconds !== undefined) &&
    Number.isSafeInteger(duration);
  return { ...(ready === undefined ? {} : { ready }), ...(hasDuration ? { remainingSeconds: duration } : {}) };
}

function parseVideoStore(value: unknown): DailyNoteSnapshot["videoStore"] {
  const state = typeof value === "string" ? value : object(value)?.sale_state ?? object(value)?.status;
  if (typeof state !== "string" || !state) return;
  switch (state) {
    case "SaleStateDoing": return "doing";
    case "SaleStateDone":
    case "SaleStateFinished": return "done";
    case "SaleStateCanStart": return "ready";
    case "SaleStateNo":
    case "SaleStateNotStart": return "idle";
    default: return "unknown";
  }
}

function parseScratchCard(value: unknown): boolean | undefined {
  const state = object(value)?.status ?? value;
  if (typeof state === "string") {
    if (/^(?:CardSign(?:State)?)?Done$/iu.test(state)) return true;
    if (/^(?:CardSign(?:State)?)?(?:Not(?:Done|Start|Sign)|No|Todo|CanSign)$/iu.test(state)) return false;
  }
  return flag(state);
}

function normalize(data: Json, source: ProfileRequestContext, region: string): DailyNoteSnapshot {
  const { game, role: { uid } } = source;
  for (const identity of [data.role_id, data.uid, data.game_uid]) {
    if (identity !== undefined && identity !== uid && identity !== Number(uid)) {
      throw new HoyoRequestError("response", "体力响应的角色与档案不一致。");
    }
  }
  if ((data.server !== undefined && data.server !== region) || (data.region !== undefined && data.region !== region) ||
      (data.game_biz !== undefined && data.game_biz !== records[game].gameBiz)) {
    throw new HoyoRequestError("response", "体力响应的游戏或区服与档案不一致。");
  }

  const energy = object(data.energy);
  const energyProgress = object(energy?.progress) ?? energy;
  const stamina = game === "gs" ? recovery(data.current_resin, data.max_resin, data.resin_recovery_time)
    : game === "sr" ? recovery(data.current_stamina, data.max_stamina, data.stamina_recover_time)
    : recovery(energyProgress?.current, energyProgress?.max, energy?.restore);
  if (!stamina) throw new HoyoRequestError("response", "官方体力响应缺少有效的当前值或上限。");
  const base = { game, uid, region, stamina };

  if (game === "gs") return { ...base,
    homeCoin: recovery(data.current_home_coin, data.max_home_coin, data.home_coin_recovery_time),
    commissionRewardReceived: flag(data.is_extra_task_reward_received),
    expeditions: parseExpeditions(data, game), weeklyDiscount: weeklyDiscount(data), transformer: parseTransformer(data.transformer),
  };
  if (game === "sr") return { ...base,
    expeditions: parseExpeditions(data, game), training: progress(data.current_train_score, data.max_train_score),
    rogue: progress(data.current_rogue_score, data.max_rogue_score), echoOfWar: progress(data.weekly_cocoon_cnt, data.weekly_cocoon_limit),
    reserveStamina: uint(data.current_reserve_stamina),
  };
  const vitality = object(data.vitality);
  return { ...base, vitality: progress(vitality?.current, vitality?.max),
    videoStore: parseVideoStore(data.vhs_sale ?? data.vhs), scratchCardDone: parseScratchCard(data.card_sign),
  };
}

function requestHeaders(source: ProfileRequestContext, query: string): Headers {
  const { account, device } = source;
  const cookie = account.cookie.trim();
  const valid = (value: string) => !/[^\x20-\x7E]/u.test(value);
  if (!cookie.includes("=") || !valid(account.cookie) || !valid(device.id ?? "") || !valid(device.fp ?? "")) {
    throw new HoyoRequestError("invalid-input", "当前档案的 Cookie 或设备字段无效。");
  }
  const time = Math.round(Date.now() / 1000);
  const nonce = randomInt(100000, 1000000);
  const hash = createHash("md5").update(`salt=${signingSalt}&t=${time}&r=${nonce}&b=&q=${query}`).digest("hex");
  const model = device.model && valid(device.model) ? device.model : "Android";
  const android = device.androidVersion && /^\d{1,2}(?:\.\d+){0,2}$/u.test(device.androidVersion) ? device.androidVersion : "12";
  const headers = new Headers({ Accept: "application/json", Cookie: cookie,
    "User-Agent": `Mozilla/5.0 (Linux; Android ${android}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.73 Mobile Safari/537.36 miHoYoBBS/${appVersion}`,
    "x-rpc-app_version": appVersion, "x-rpc-client_type": "5", Referer: "https://webstatic.mihoyo.com/",
    DS: `${time},${nonce},${hash}`,
  });
  if (device.id) headers.set("x-rpc-device_id", device.id);
  if (device.id && device.fp) headers.set("x-rpc-device_fp", device.fp);
  return headers;
}

async function readPayload(response: Response): Promise<Json | undefined> {
  if (!response.body) return;
  if (Number(response.headers.get("Content-Length")) > maxResponseBytes) {
    await response.body.cancel().catch(() => undefined);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxResponseBytes) return;
      text += decoder.decode(next.value, { stream: true });
    }
    return object(JSON.parse(text + decoder.decode()));
  } catch {
    return;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function apiError(payload: Json | undefined, status: number, retcode: number | undefined): HoyoRequestError {
  const message = [payload?.message, payload?.msg, object(payload?.data)?.message].find((item) => typeof item === "string") ?? "";
  const code = status === 401 || status === 429 ? "http" : "api";
  if (status === 429) return new DailyNoteRequestError("rate-limited", code, status, retcode);
  if ((retcode !== undefined && riskCodes.has(retcode)) || /验证码|captcha|geetest|challenge|风控/iu.test(String(message))) {
    return new DailyNoteRequestError("risk", code, status, retcode);
  }
  if (/visit too frequently|too frequent|rate limit|频繁/iu.test(String(message))) return new DailyNoteRequestError("rate-limited", code, status, retcode);
  if (status === 401 || (retcode !== undefined && expiredCodes.has(retcode))) return new DailyNoteRequestError("expired", code, status, retcode);
  return new HoyoRequestError("api", "官方体力接口拒绝请求。", status, retcode);
}

export async function readDailyNote(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: DailyNoteOptions = {}, verifyProfile?: () => Promise<void>): Promise<DailyNoteSnapshot> {
  const { game, role: { uid, gameBiz } } = source;
  const route = Object.hasOwn(records, game) ? records[game] : undefined;
  const legacyRegion = game === "gs" && !/^[125]\d{8}$/u.test(uid)
    ? undefined
    : route?.regions[game !== "zzz" && uid.startsWith("5") ? 1 : 0];
  const region = source.role.region.trim() || legacyRegion;
  if (!route?.uid.test(uid) || !region || !route.regions.includes(region) || (gameBiz && gameBiz !== route.gameBiz) ||
      (game !== "zzz" && uid.startsWith("5") !== (region === route.regions[1]))) {
    throw new HoyoRequestError("invalid-input", "体力查询仅支持档案中已确认的国服游戏角色和区服。");
  }
  const endpoint = new URL(route.path, origin);
  endpoint.searchParams.set("role_id", uid);
  endpoint.searchParams.set("server", region);
  const headers = requestHeaders(source, endpoint.search.slice(1));

  async function guard() {
    if (signal?.aborted) throw new HoyoRequestError("transport", "体力查询已取消。");
    await verifyProfile?.();
    if (signal?.aborted) throw new HoyoRequestError("transport", "体力查询已取消。");
  }

  await guard();
  const timeout = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await transport(endpoint, {
      method: "GET", headers, credentials: "omit", redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new HoyoRequestError("transport", "官方体力查询请求未完成。");
  }
  if (!response.ok && response.status !== 401 && response.status !== 429) {
    await response.body?.cancel().catch(() => undefined);
    throw new HoyoRequestError("http", "官方体力接口返回 HTTP 错误。", response.status);
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw apiError(undefined, response.status, undefined);
  }
  const payload = await readPayload(response);
  await guard();
  const retcode = whole(payload?.retcode);
  if (response.status === 401) throw apiError(payload, response.status, retcode);
  if (retcode === undefined) throw new HoyoRequestError("response", "官方体力响应格式无效。");
  if (retcode !== 0) throw apiError(payload, response.status, retcode);
  const data = object(payload?.data);
  if (!data) throw new HoyoRequestError("response", "官方体力响应缺少有效数据。");
  return normalize(data, source, region);
}
