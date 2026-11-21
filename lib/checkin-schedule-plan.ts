import { MAX_PROFILE_ID } from "@lotus-yunzai/account";

type ScheduleMode = "fixed" | "random";
type EntryMode = ScheduleMode | "late_random";

interface ScheduleWindow {
  readonly window_start: string;
  readonly window_end: string;
}

export interface CheckinScheduleConfig {
  readonly enable?: boolean;
  readonly run_due_cron?: string;
  readonly plan_generate_cron?: string;
  readonly catch_up_cron?: string;
  readonly mode?: ScheduleMode;
  readonly fixed_time?: string;
  readonly random?: Partial<ScheduleWindow> & { readonly notify_before?: boolean };
  readonly late_registration?: Partial<ScheduleWindow> & { readonly enable?: boolean; readonly notify?: boolean };
}

export interface CheckinScheduleProfile {
  readonly qq: string;
  readonly profileId?: number;
  readonly name?: string;
  readonly enabled: boolean;
  readonly schedule?: {
    readonly mode?: ScheduleMode | "inherit";
    readonly fixedTime?: string;
    readonly allowRandom?: boolean;
  };
}

const checkinScheduleGames = ["genshin", "honkai_sr", "zzz", "tears_of_themis", "honkai3rd", "honkai2"] as const;
export type CheckinScheduleGame = typeof checkinScheduleGames[number];

export interface CheckinScheduleCommunityRetry {
  readonly forums: readonly string[];
  readonly games?: readonly CheckinScheduleGame[];
  readonly attempts: number;
  readonly nextAt: string;
  readonly verifiedUnsent?: true;
  readonly accountKey?: string;
  readonly otherFailure?: boolean;
  readonly initialMessage?: string;
}

const communityWriteStatuses = ["pending", "accepted", "already", "rejected", "blocked", "unconfirmed", "retryable"] as const;
export type CheckinCommunityWriteStatus = typeof communityWriteStatuses[number];
const communityWriteForums = new Set(["1", "2", "3", "4", "5", "6", "8", "9", "10"]);
const gameWriteStatuses = ["pending", "confirmed", "unconfirmed", "rejected"] as const;
export type CheckinGameWriteStatus = typeof gameWriteStatuses[number];
const gameWriteKey = /^(?:genshin|honkai_sr|zzz|tears_of_themis|honkai3rd|honkai2):(?:cn:(?:[0-9a-f]{64}|legacy)|os:[0-9a-f]{64}:[0-9a-f]{64})$/u;

export function legacyGameWriteKey(game: CheckinScheduleGame) {
  return `${game}:cn:legacy`;
}

export interface CheckinScheduleEntry {
  readonly qq: string;
  readonly profileId: number;
  readonly name: string;
  readonly time: string;
  readonly mode: EntryMode;
  readonly notified: boolean;
  readonly noticeAttemptedAt?: string;
  readonly done: boolean;
  readonly late?: true;
  readonly lateRegisteredAt?: string;
  readonly runningAt?: string;
  readonly doneAt?: string;
  readonly ok?: boolean;
  readonly stage?: string;
  readonly message?: string;
  readonly communityRetry?: CheckinScheduleCommunityRetry;
  readonly communityWrites?: Readonly<Record<string, CheckinCommunityWriteStatus>>;
  readonly communityWriteAccount?: string;
  readonly gameWrites?: Readonly<Record<string, CheckinGameWriteStatus>>;
  readonly gameWriteAccount?: string;
  readonly gameWritesUnknown?: true;
  readonly manualOnly?: true;
}

export interface CheckinSchedulePlan {
  readonly version: 1;
  readonly date: string;
  readonly mode: ScheduleMode;
  readonly window: ScheduleWindow & { readonly notify_before: boolean };
  readonly generatedAt: string;
  readonly entries: readonly CheckinScheduleEntry[];
  readonly manualSeed?: true;
}

export const legacyUnconfirmedStage = "legacy-unconfirmed";
export const checkinHandbackHoldStage = "handoff-held";

interface PlanContext {
  readonly config?: CheckinScheduleConfig;
  readonly now?: Date | number;
}

interface ReconcileContext extends PlanContext {
  readonly profiles?: readonly CheckinScheduleProfile[];
  readonly random?: () => number;
}

interface GenerateContext extends ReconcileContext {
  readonly date?: string;
}

const chinaOffset = 8 * 60 * 60_000;
const day = 24 * 60 * 60_000;
const qqPattern = /^[1-9]\d{0,18}$/u;
const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const datePattern = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;
const stampPattern = /^(.{10})T(.{5}):[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function isMode(value: unknown): value is ScheduleMode {
  return value === "fixed" || value === "random";
}

function invalid(): never {
  throw new TypeError("自动签到计划格式有误。");
}

export function isCheckinScheduleDate(value: unknown): value is string {
  const match = typeof value === "string" && datePattern.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : ([4, 6, 9, 11].includes(month) ? 30 : 31);
  return year > 0 && Number(d) <= days;
}

export function checkinScheduleMinute(value: unknown): number {
  const match = typeof value === "string" && timePattern.exec(value);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function requiredMinute(value: unknown): number {
  const minute = checkinScheduleMinute(value);
  if (!Number.isInteger(minute)) throw new TypeError("签到时间须为有效的 HH:mm。");
  return minute;
}

function isTimestamp(value: unknown): value is string {
  const match = typeof value === "string" && stampPattern.exec(value);
  return !!match && isCheckinScheduleDate(match[1]) && Number.isInteger(checkinScheduleMinute(match[2]));
}

export function checkinScheduleClock(now: Date | number = Date.now()) {
  const timestamp = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(timestamp)) throw new TypeError("自动签到时间无效。");
  const local = new Date(timestamp + chinaOffset).toISOString();
  const date = local.slice(0, 10);
  const tomorrow = new Date(timestamp + chinaOffset + day).toISOString().slice(0, 10);
  if (!isCheckinScheduleDate(date) || !isCheckinScheduleDate(tomorrow)) invalid();
  const time = local.slice(11, 16);
  return { date, tomorrow, time, minute: requiredMinute(time), iso: `${local.slice(0, -1)}+08:00` };
}

function checkedWindow(start: string, end: string) {
  if (requiredMinute(start) > requiredMinute(end)) throw new TypeError("签到窗口结束时间不得早于开始时间。");
  return { window_start: start, window_end: end };
}

function configOf(config: CheckinScheduleConfig = {}) {
  const { mode = "fixed", fixed_time: fixedTime = "04:30", random, late_registration: late } = config;
  if (!isMode(mode)) throw new TypeError("自动签到模式无效。");
  requiredMinute(fixedTime);
  return {
    mode, fixedTime,
    random: {
      ...checkedWindow(random?.window_start ?? "00:00", random?.window_end ?? "23:30"),
      notify_before: random?.notify_before ?? true,
    },
    late: {
      ...checkedWindow(late?.window_start ?? "23:30", late?.window_end ?? "23:59"),
      enabled: late?.enable ?? true,
    },
  };
}

type Scheduler = ReturnType<typeof configOf>;
type Clock = ReturnType<typeof checkinScheduleClock>;

function validIdentity(qq: unknown, id: unknown): id is number {
  return typeof qq === "string" && qqPattern.test(qq) &&
    typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= MAX_PROFILE_ID;
}

function keyFor({ qq, profileId = 1 }: { readonly qq: string; readonly profileId?: number }) {
  if (!validIdentity(qq, profileId)) throw new TypeError("自动签到档案的 QQ 或编号无效。");
  return `${qq}:${profileId}`;
}

function enabledProfiles(profiles: readonly CheckinScheduleProfile[]) {
  const unique = new Map<string, CheckinScheduleProfile>();
  for (const profile of profiles) {
    const key = keyFor(profile);
    if (!unique.has(key) || !profile.enabled) unique.set(key, profile);
  }
  return [...unique.values()].filter(profile => profile.enabled);
}

function profileMode(profile: CheckinScheduleProfile, scheduler: Scheduler): ScheduleMode {
  const { mode, allowRandom } = profile.schedule ?? {};
  if (mode === "fixed") return "fixed";
  if (mode === "random" && allowRandom !== false) return "random";
  return scheduler.mode;
}

function fixedTime(profile: CheckinScheduleProfile, scheduler: Scheduler) {
  const time = profile.schedule?.mode === "fixed" && profile.schedule.fixedTime
    ? profile.schedule.fixedTime : scheduler.fixedTime;
  requiredMinute(time);
  return time;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function minuteTime(minute: number) {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

function entryFor(profile: CheckinScheduleProfile, time: string, mode: EntryMode): CheckinScheduleEntry {
  return { qq: profile.qq, profileId: profile.profileId ?? 1, name: profile.name ?? "", time, mode, notified: false, done: false };
}

function lateEntry(profile: CheckinScheduleProfile, scheduler: Scheduler, lateCount: number, clock: Clock) {
  const start = requiredMinute(scheduler.late.window_start);
  const end = requiredMinute(scheduler.late.window_end);
  return { ...entryFor(profile, minuteTime(start + lateCount % (end - start + 1)), "late_random"), late: true as const,
    lateRegisteredAt: clock.iso };
}

function compareEntries(a: CheckinScheduleEntry, b: CheckinScheduleEntry) {
  return a.time.localeCompare(b.time) || a.qq.localeCompare(b.qq) || a.profileId - b.profileId;
}

function randomEntry(profile: CheckinScheduleProfile, index: number, count: number, scheduler: Scheduler, random: () => number) {
  const start = requiredMinute(scheduler.random.window_start);
  const end = requiredMinute(scheduler.random.window_end);
  const step = (end - start) / count;
  let jitter = 0;
  if (step > 1) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new TypeError("签到随机数须在 [0, 1) 内。");
    jitter = Math.floor(sample * step);
  }
  const minute = Math.min(end, Math.round(start + step * index + jitter));
  return entryFor(profile, minuteTime(minute), "random");
}

export function generateCheckinSchedulePlan({ date, profiles = [], config, now, random = Math.random }: GenerateContext = {}): CheckinSchedulePlan {
  const clock = checkinScheduleClock(now);
  const planDate = date ?? clock.tomorrow;
  if (!isCheckinScheduleDate(planDate)) invalid();
  const scheduler = configOf(config);
  const fixed: CheckinScheduleEntry[] = [];
  const variable: CheckinScheduleProfile[] = [];
  for (const profile of enabledProfiles(profiles)) {
    if (profileMode(profile, scheduler) === "random") variable.push(profile);
    else fixed.push(entryFor(profile, fixedTime(profile, scheduler), "fixed"));
  }
  const entries = [...fixed, ...variable.map((profile, index) =>
    randomEntry(profile, index, variable.length, scheduler, random))].sort(compareEntries);
  return { version: 1, date: planDate, mode: scheduler.mode, window: scheduler.random, generatedAt: clock.iso, entries };
}

function entryPriority(entry: CheckinScheduleEntry) {
  if (entry.done) return 5;
  if (entry.runningAt) return 4;
  if (entry.communityRetry || entry.communityWrites || entry.gameWriteAccount || entry.gameWritesUnknown) return 3;
  if (entry.notified) return 2;
  return entry.noticeAttemptedAt ? 1 : 0;
}

function entryIndex(entries: readonly CheckinScheduleEntry[]) {
  const result = new Map<string, CheckinScheduleEntry>();
  for (const entry of entries) {
    const key = keyFor(entry);
    const previous = result.get(key);
    if (!previous || entryPriority(entry) > entryPriority(previous)) result.set(key, entry);
  }
  return result;
}

function withManualJournal(planned: CheckinScheduleEntry, manual: CheckinScheduleEntry) {
  const { manualOnly: _manualOnly, ...journal } = manual;
  return { ...journal, ...planned };
}

function inLateWindow(date: string, scheduler: Scheduler, clock: Clock) {
  return date === clock.tomorrow || (date === clock.date && clock.minute <= requiredMinute(scheduler.late.window_end));
}

export function reconcileCheckinSchedulePlan(existing: CheckinSchedulePlan,
  { profiles = [], config, now, random = Math.random }: ReconcileContext = {}): CheckinSchedulePlan {
  if (existing.manualSeed) {
    const initial = generateCheckinSchedulePlan({ date: existing.date, profiles, config, now, random });
    const previous = entryIndex(existing.entries);
    const planned = initial.entries.map(entry => {
      const key = keyFor(entry);
      const current = previous.get(key);
      previous.delete(key);
      return current?.manualOnly ? withManualJournal(entry, current) : current ?? entry;
    });
    return { ...initial, entries: [...planned, ...previous.values()].sort(compareEntries) };
  }
  const scheduler = configOf(config);
  const clock = checkinScheduleClock(now);
  const previous = entryIndex(existing.entries);
  const entries: CheckinScheduleEntry[] = [];
  const configured = enabledProfiles(profiles).map(profile => ({ profile, mode: profileMode(profile, scheduler) }));
  const randomCount = configured.filter(({ mode }) => mode === "random").length;
  let randomIndex = 0;
  let lateCount = [...previous.values()].filter(entry => entry.mode === "late_random").length;
  for (const { profile, mode } of configured) {
    const key = keyFor(profile);
    const current = previous.get(key);
    previous.delete(key);
    const slot = mode === "random" ? randomIndex++ : 0;
    if (current?.manualOnly) {
      const planned = mode === "fixed" ? entryFor(profile, fixedTime(profile, scheduler), mode)
        : scheduler.late.enabled && inLateWindow(existing.date, scheduler, clock) ? lateEntry(profile, scheduler, lateCount++, clock) : undefined;
      entries.push(planned ? withManualJournal(planned, current) : current);
    } else if (current && (current.done || current.runningAt || current.communityRetry || current.communityWrites || current.gameWriteAccount || current.gameWritesUnknown ||
        (mode === "random" && (current.mode === "random" || current.mode === "late_random")))) {
      entries.push(current);
    } else if (mode === "fixed") {
      const time = fixedTime(profile, scheduler);
      entries.push(current?.mode === "fixed" && current.time === time ? current : entryFor(profile, time, mode));
    } else if (current) {
      entries.push(randomEntry(profile, slot, randomCount, scheduler, random));
    } else if (scheduler.late.enabled && inLateWindow(existing.date, scheduler, clock)) {
      entries.push(lateEntry(profile, scheduler, lateCount++, clock));
    }
  }
  for (const entry of previous.values()) {
    if (entry.done || entry.runningAt || entry.communityRetry || entry.communityWrites || entry.gameWriteAccount || entry.gameWritesUnknown) entries.push(entry);
  }
  return { ...existing, mode: scheduler.mode, window: scheduler.random, entries: entries.sort(compareEntries) };
}

export type LateCheckinRegistration =
  | { readonly plan: CheckinSchedulePlan; readonly entry: CheckinScheduleEntry; readonly reason?: never }
  | { readonly plan: CheckinSchedulePlan | null; readonly reason: "profile_disabled" | "plan_not_found" |
      "entry_exists" | "late_registration_disabled" | "late_window_expired" };

export function addLateCheckinScheduleProfile(plan: CheckinSchedulePlan | null | undefined, profile: CheckinScheduleProfile,
  { config, now }: PlanContext = {}): LateCheckinRegistration {
  const key = keyFor(profile);
  if (!profile.enabled) return { plan: plan ?? null, reason: "profile_disabled" };
  if (!plan) return { plan: null, reason: "plan_not_found" };
  const previous = entryIndex(plan.entries);
  const current = previous.get(key);
  if (current && !current.manualOnly) return { plan, reason: "entry_exists" };
  const scheduler = configOf(config);
  if (!scheduler.late.enabled) return { plan, reason: "late_registration_disabled" };
  const clock = checkinScheduleClock(now);
  const mode = profileMode(profile, scheduler);
  if ((plan.date !== clock.date && plan.date !== clock.tomorrow) ||
      (mode === "random" && !inLateWindow(plan.date, scheduler, clock))) {
    return { plan, reason: "late_window_expired" };
  }
  const planned = mode === "fixed" ? entryFor(profile, fixedTime(profile, scheduler), mode)
    : lateEntry(profile, scheduler, [...previous.values()].filter(item => item.mode === "late_random").length, clock);
  const entry = current ? withManualJournal(planned, current) : planned;
  previous.set(key, entry);
  return { plan: { ...plan, entries: [...previous.values()].sort(compareEntries) }, entry };
}

function parseCommunityRetry(value: unknown): CheckinScheduleCommunityRetry | undefined {
  if (value === undefined) return;
  const retry = record(value);
  if (!retry) invalid();
  const { forums, games, attempts, nextAt, otherFailure, initialMessage, verifiedUnsent, accountKey } = retry;
  if (games !== undefined && (!Array.isArray(games) || new Set(games).size !== games.length ||
      !games.every(key => checkinScheduleGames.some(game => game === key)))) invalid();
  if (!Array.isArray(forums) || !forums.every((id): id is string => typeof id === "string" && /^[1-9]\d*$/u.test(id)) ||
      typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0 ||
      !isTimestamp(nextAt) || (verifiedUnsent !== undefined && verifiedUnsent !== true) ||
      (verifiedUnsent && ((!forums.length && !games?.length) || forums.length > 9 || new Set(forums).size !== forums.length ||
        !forums.every(id => communityWriteForums.has(id)) || typeof accountKey !== "string" || !communityAccountPattern.test(accountKey))) ||
      (!verifiedUnsent && accountKey !== undefined) ||
      (otherFailure !== undefined && typeof otherFailure !== "boolean") ||
      (initialMessage !== undefined && typeof initialMessage !== "string")) invalid();
  return { forums, ...(games?.length && { games: games as CheckinScheduleGame[] }), attempts, nextAt,
    ...(verifiedUnsent && { verifiedUnsent, accountKey: accountKey as string }), ...(otherFailure !== undefined && { otherFailure }),
    ...(initialMessage !== undefined && { initialMessage }) };
}

const communityAccountPattern = /^[0-9a-f]{64}$/u;

function parseWrites<Status extends string>(value: unknown, statuses: readonly Status[], validKey: (key: string) => boolean) {
  if (value === undefined) return;
  const writes = record(value);
  if (!writes || (Object.getPrototypeOf(writes) !== Object.prototype && Object.getPrototypeOf(writes) !== null)) invalid();
  const checked: Record<string, Status> = {};
  for (const key of Reflect.ownKeys(writes)) {
    if (typeof key !== "string" || !validKey(key)) invalid();
    const status = statuses.find(status => status === writes[key]);
    if (!status) invalid();
    checked[key] = status;
  }
  return checked;
}

function parseEntry(value: unknown): CheckinScheduleEntry {
  const entry = record(value);
  if (!entry) invalid();
  const { qq, profileId = 1, name = "", time, mode, notified = false, noticeAttemptedAt, done = false,
    ok, stage, message, late, lateRegisteredAt, runningAt, doneAt, communityWriteAccount, gameWriteAccount, gameWritesUnknown, manualOnly } = entry;
  if (typeof qq !== "string" || !validIdentity(qq, profileId) || (mode !== "late_random" && !isMode(mode)) ||
      typeof time !== "string" || !Number.isInteger(checkinScheduleMinute(time)) ||
      typeof name !== "string" || typeof notified !== "boolean" || typeof done !== "boolean" ||
      (noticeAttemptedAt !== undefined && !isTimestamp(noticeAttemptedAt)) ||
      (ok !== undefined && typeof ok !== "boolean") || (stage !== undefined && typeof stage !== "string") ||
      (message !== undefined && typeof message !== "string") || (late !== undefined && late !== true) ||
      (lateRegisteredAt !== undefined && !isTimestamp(lateRegisteredAt)) ||
      (runningAt !== undefined && !isTimestamp(runningAt)) || (doneAt !== undefined && !isTimestamp(doneAt)) ||
      (communityWriteAccount !== undefined && (typeof communityWriteAccount !== "string" || !communityAccountPattern.test(communityWriteAccount))) ||
      (gameWriteAccount !== undefined && (typeof gameWriteAccount !== "string" || !communityAccountPattern.test(gameWriteAccount))) ||
      (gameWritesUnknown !== undefined && gameWritesUnknown !== true) || (manualOnly !== undefined && manualOnly !== true)) invalid();
  const communityRetry = parseCommunityRetry(entry.communityRetry);
  const communityWrites = parseWrites(entry.communityWrites, communityWriteStatuses, key => communityWriteForums.has(key));
  const gameWrites = parseWrites(entry.gameWrites, gameWriteStatuses, key => gameWriteKey.test(key));
  if (gameWrites && Object.keys(gameWrites).length > 0 && !gameWriteAccount) invalid();
  return { qq, profileId, name, time, mode, notified, ...(noticeAttemptedAt && { noticeAttemptedAt }), done, ...(late && { late }),
    ...(lateRegisteredAt && { lateRegisteredAt }), ...(runningAt && { runningAt }), ...(doneAt && { doneAt }),
    ...(ok !== undefined && { ok }), ...(stage !== undefined && { stage }), ...(message !== undefined && { message }),
    ...(communityRetry && { communityRetry }), ...(communityWrites && { communityWrites }), ...(communityWriteAccount && { communityWriteAccount }),
    ...(gameWrites && { gameWrites }), ...(gameWriteAccount && { gameWriteAccount }), ...(gameWritesUnknown && { gameWritesUnknown }),
    ...(manualOnly && { manualOnly }) };
}

/** Validate the on-disk version 1 shape before its entries can be scheduled. */
export function parseCheckinSchedulePlan(value: unknown): CheckinSchedulePlan {
  const plan = record(value);
  if (!plan) invalid();
  const { version, date, mode, generatedAt, entries, manualSeed } = plan;
  const window = record(plan.window);
  if (version !== 1 || !isCheckinScheduleDate(date) || !isMode(mode) || !isTimestamp(generatedAt) ||
      !window || typeof window.window_start !== "string" || typeof window.window_end !== "string" ||
      typeof window.notify_before !== "boolean" || !Array.isArray(entries) || (manualSeed !== undefined && manualSeed !== true)) invalid();
  const bounds = checkedWindow(window.window_start, window.window_end);
  return { version, date, mode, window: { ...bounds, notify_before: window.notify_before }, generatedAt, ...(manualSeed && { manualSeed }),
    entries: [...entryIndex(entries.map(parseEntry)).values()].sort(compareEntries) };
}
