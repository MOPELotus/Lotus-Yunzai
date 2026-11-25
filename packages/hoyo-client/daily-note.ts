import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
import { normalizeProfileRoleArtworkUrl, type Game, type ProfileRequestContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "./credentials.ts";
import { HoyoRequestError } from "./errors.ts";
import { readCnGameRecord } from "./game-record.ts";
import type { HoYoLabCheckinOptions } from "./hoyolab-checkin-transport.ts";
import { openHoYoLabZzzOwnedRecord, type HoYoLabZzzRecordAccount } from "./zzz-game-record.ts";

export interface DailyNoteProgress {
  readonly current: number;
  readonly max: number;
}

export interface DailyNoteRecovery extends DailyNoteProgress {
  readonly recoverySeconds?: number;
}

export interface DailyNoteExpedition {
  readonly name: string;
  readonly remainingSeconds?: number;
  readonly avatars: readonly (string | undefined)[];
}

export interface DailyNoteSnapshot {
  readonly game: Game;
  readonly uid: string;
  readonly region: string;
  readonly stamina: DailyNoteRecovery;
  readonly recoveryText?: string;
  readonly homeCoin?: DailyNoteRecovery;
  readonly commissionRewardReceived?: boolean;
  readonly expeditions?: { readonly current?: number; readonly max?: number; readonly remainingSeconds?: number;
    readonly entries?: readonly DailyNoteExpedition[] };
  readonly starRailCheckin?: "signed" | "unsigned" | "unavailable";
  readonly weeklyDiscount?: DailyNoteProgress;
  readonly transformer?: { readonly ready?: boolean; readonly remainingSeconds?: number };
  readonly training?: DailyNoteProgress;
  readonly rogue?: DailyNoteProgress;
  readonly echoOfWar?: DailyNoteProgress;
  readonly reserveStamina?: number;
  readonly vitality?: DailyNoteProgress;
  readonly videoStore?: "doing" | "done" | "ready" | "idle" | "unknown";
  readonly videoStoreText?: string;
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

function expeditionRemaining(row: Json, now: number) {
  const remaining = uint(row.remaining_time ?? row.remained_time ?? row.remain_time ?? row.left_time);
  if (remaining !== undefined) return remaining;
  const finish = uint(row.finish_time);
  if (finish === undefined || finish < 1_000_000_000) return finish;
  const timestamp = finish >= 1_000_000_000_000 ? Math.floor(finish / 1000) : finish;
  return Math.max(0, timestamp - now);
}

function parseExpeditions(data: Json, game: "gs" | "sr"): DailyNoteSnapshot["expeditions"] {
  const list = Array.isArray(data.expeditions) ? data.expeditions.map(object).filter(row => row !== undefined) : undefined;
  const now = Math.floor(Date.now() / 1000);
  const active = list?.filter(row => {
    const status = row.status ?? row.state;
    if (typeof status === "string" && /^(?:none|idle|empty|未派遣)$/iu.test(status)) return false;
    return expeditionRemaining(row, now) !== undefined || (typeof status === "string" && status.length > 0) ||
      (Array.isArray(row.avatars) && row.avatars.length > 0) || (game === "sr" && typeof row.name === "string" && !!row.name.trim());
  });
  const inferred = list?.length ? active?.length : undefined;
  const current = uint(game === "sr" ? data.accepted_expedition_num ?? data.accepted_epedition_num ?? data.current_expedition_num
    : data.current_expedition_num) ?? inferred;
  const max = uint(game === "sr" ? data.total_expedition_num ?? data.max_expedition_num : data.max_expedition_num)
    ?? (list?.length || undefined);
  let remainingSeconds: number | undefined;
  for (const row of active ?? []) {
    const left = expeditionRemaining(row, now);
    if (left !== undefined) remainingSeconds = Math.min(remainingSeconds ?? left, left);
  }
  const entries = game === "sr" && active?.slice(0, 8).map((row, index) => {
    const name = typeof row.name === "string" ? row.name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 80) : "";
    return { name: name || $t("daily-note.text_26d2b74fe7", { "value1": index + 1 }), remainingSeconds: expeditionRemaining(row, now),
      avatars: Array.isArray(row.avatars) ? row.avatars.slice(0, 4).map(normalizeProfileRoleArtworkUrl) : [] };
  });
  if (current !== undefined || max !== undefined || remainingSeconds !== undefined || (entries && entries.length)) return {
    ...(current === undefined ? {} : { current }), ...(max === undefined ? {} : { max }),
    ...(remainingSeconds === undefined ? {} : { remainingSeconds }), ...(entries && { entries }),
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

function dailyNoteLabel(value: unknown) {
  if (typeof value !== "string") return;
  const label = value.trim();
  if (/^[\p{Script=Han}\d\p{Zs}:：.,，。%+-]{1,48}$/u.test(label)) return label;
}

function parseVideoStore(state: unknown): DailyNoteSnapshot["videoStore"] {
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

function normalize(data: Json, game: Game, uid: string, region: string, gameBiz: string = noteBiz[game]): DailyNoteSnapshot {
  for (const identity of [data.role_id, data.uid, data.game_uid]) {
    if (identity !== undefined && identity !== uid && identity !== Number(uid)) {
      throw new HoyoRequestError("response", $t("daily-note.text_ebad213c04"));
    }
  }
  if ((data.server !== undefined && data.server !== region) || (data.region !== undefined && data.region !== region) ||
      (data.game_biz !== undefined && data.game_biz !== gameBiz)) {
    throw new HoyoRequestError("response", $t("daily-note.text_b45863fd07"));
  }

  const energy = object(data.energy);
  const energyProgress = object(energy?.progress) ?? energy;
  const stamina = game === "gs" ? recovery(data.current_resin, data.max_resin, data.resin_recovery_time)
    : game === "sr" ? recovery(data.current_stamina, data.max_stamina, data.stamina_recover_time)
    : recovery(energyProgress?.current, energyProgress?.max, energy?.restore);
  if (!stamina) throw new HoyoRequestError("response", $t("daily-note.text_4794ac2548"));
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
  const rawStore = data.vhs_sale ?? data.vhs;
  const store = object(rawStore);
  const state = typeof rawStore === "string" ? rawStore : store?.sale_state || store?.status || store?.text;
  const videoStore = parseVideoStore(state);
  return { ...base, recoveryText: dailyNoteLabel(energyProgress?.rest) ?? dailyNoteLabel(energy?.rest),
    vitality: progress(vitality?.current, vitality?.max), videoStore,
    videoStoreText: videoStore === undefined || videoStore === "unknown" ? dailyNoteLabel(store?.text ?? state) : undefined,
    scratchCardDone: parseScratchCard(data.card_sign),
  };
}

export async function readDailyNote(source: ProfileRequestContext, transport: HoyoTransport,
  { signal }: DailyNoteOptions = {}, verifyProfile?: () => Promise<void>): Promise<DailyNoteSnapshot> {
  const { data, region } = await readCnGameRecord(source, transport, { kind: "daily-note", signal }, verifyProfile);
  return normalize(data, source.game, source.role.uid, region);
}

export async function readHoYoLabZzzDailyNote(
  source: HoYoLabZzzRecordAccount, transport: HoyoTransport, options: HoYoLabCheckinOptions,
): Promise<DailyNoteSnapshot> {
  const { role, read } = await openHoYoLabZzzOwnedRecord(source, transport, options);
  return normalize(await read("note"), "zzz", role.uid, role.region, role.gameBiz);
}
