import type { Game, ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";

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

export { GameRecordRequestError as DailyNoteRequestError, isGameRecordCookieExpired as isDailyNoteCookieExpired } from "./game-record.ts";

const noteBiz = { gs: "hk4e_cn", sr: "hkrpg_cn", zzz: "nap_cn" } as const;
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
      (data.game_biz !== undefined && data.game_biz !== noteBiz[game])) {
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

export async function readDailyNote(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: DailyNoteOptions = {}, verifyProfile?: () => Promise<void>): Promise<DailyNoteSnapshot> {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "daily-note", signal }, verifyProfile);
  return normalize(data, source, region);
}
