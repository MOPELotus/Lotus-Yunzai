import { Job } from "node-schedule";
import { isDeepStrictEqual } from "node:util";
import type { CheckinNotifyResult } from "./checkin-notify.ts";
import { notifyCheckinPlan } from "./checkin-plan-notice.ts";
import {
  addLateCheckinScheduleProfile, checkinScheduleClock, generateCheckinSchedulePlan, reconcileCheckinSchedulePlan,
  type CheckinScheduleConfig, type CheckinScheduleEntry, type CheckinSchedulePlan, type CheckinScheduleProfile,
} from "./checkin-schedule-plan.ts";
import type { createCheckinScheduleStore } from "./checkin-schedule-store.ts";
import { createCheckinScheduler } from "./checkin-scheduler.ts";

type Store = ReturnType<typeof createCheckinScheduleStore>;
type Runner = Pick<Parameters<typeof createCheckinScheduler>[0], "runProfile" | "onComplete">;
type Tick = Awaited<ReturnType<ReturnType<typeof createCheckinScheduler>["tick"]>>;
type RuntimeTick = Tick | { readonly status: "failed" };
type PlanNotice = (entry: CheckinScheduleEntry, date: string, late: boolean, isCurrent: () => Promise<boolean>) =>
  Promise<Pick<CheckinNotifyResult, "status">>;
interface TomorrowPlan {
  readonly plan: CheckinSchedulePlan;
  readonly notices?: Awaited<ReturnType<typeof notifyCheckinPlan>>;
}
const dueCron = "0 * * * * *";
const planCron = "0 0 0 * * *";

function normalizeCron(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return;
  const fields = value.trim().split(/\s+/u);
  if (fields.length === 7 && fields[6] === "*") fields.pop();
  if (fields.length === 5) fields.unshift("0");
  if (fields.length !== 6) return;
  for (const index of [3, 5]) if (fields[index] === "?") fields[index] = "*";
  return fields.join(" ");
}

function dailySecond(rule: string) {
  const fixed = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \* \*$/u.exec(rule);
  if (!fixed) return;
  const [second, minute, hour] = fixed.slice(1).map(Number) as [number, number, number];
  if (second < 60 && minute < 60 && hour < 24) return hour * 3600 + minute * 60 + second;
}

export function createCheckinScheduleRuntime({ store, config: initial, listProfiles, signal, runProfile, onComplete, onNotice, now = Date.now }: Runner & {
  readonly store: Store;
  readonly config: CheckinScheduleConfig;
  readonly listProfiles: () => Promise<readonly CheckinScheduleProfile[]>;
  readonly signal: AbortSignal;
  readonly onNotice?: PlanNotice;
  readonly now?: () => number;
}) {
  const jobs: Job[] = [];
  let config = structuredClone(initial);
  let planJob: ReturnType<typeof schedule> | undefined;
  let operation: Promise<RuntimeTick | undefined> | undefined;
  let preparation: Promise<TomorrowPlan | undefined> | undefined;
  let forcedPlan: Promise<TomorrowPlan | undefined> | undefined;
  let prepared: { readonly date: string; readonly config: CheckinScheduleConfig } | undefined;
  let started = false;
  let stopped = false;
  let immediateDue = false;

  function canRun(snapshot: CheckinScheduleConfig, force = false) {
    return !stopped && !signal.aborted && (force || snapshot.enable !== false);
  }

  async function notifyPlanned(plan: CheckinSchedulePlan, snapshot: CheckinScheduleConfig, late: boolean, force = false) {
    if (!canRun(snapshot, force) || !onNotice) return;
    return notifyCheckinPlan(store, plan, (slot, date) => onNotice(slot, date, late, async () => {
      if (!canRun(snapshot, force)) return false;
      const clock = checkinScheduleClock(now());
      if (date !== clock.tomorrow && (!late || date !== clock.date)) return false;
      const current = await store.read(date);
      return current?.generatedAt === plan.generatedAt && current.entries.some(entry =>
        entry.qq === slot.qq && entry.profileId === slot.profileId && entry.time === slot.time && entry.mode === slot.mode &&
        entry.noticeAttemptedAt === slot.noticeAttemptedAt && !entry.notified && !entry.done);
    }), signal);
  }

  async function prepareTomorrow(profiles: readonly CheckinScheduleProfile[], snapshot: CheckinScheduleConfig,
    at: number, purpose: "scheduled" | "catch-up" | "manual"): Promise<TomorrowPlan | undefined> {
    const force = purpose === "manual";
    const { tomorrow } = checkinScheduleClock(at);
    if (!canRun(snapshot, force) || (!force && !profiles.some(profile => profile.enabled) && !await store.read(tomorrow))) return;
    const saved = await store.update(tomorrow, previous => {
      if (!canRun(snapshot, force) || checkinScheduleClock(now()).tomorrow !== tomorrow ||
          (previous && purpose === "catch-up")) return { result: undefined };
      const plan = previous && !force ? reconcileCheckinSchedulePlan(previous, { now: at, profiles, config: snapshot }) :
        generateCheckinSchedulePlan({ date: tomorrow, now: at, profiles, config: snapshot });
      return { plan, result: plan };
    });
    if (!saved) return;
    prepared = { date: tomorrow, config: snapshot };
    const notices = force || snapshot.random?.notify_before !== false ? await notifyPlanned(saved, snapshot, false, force) : undefined;
    return { plan: saved, notices };
  }

  function prepare(snapshot: CheckinScheduleConfig, at: number, scheduled: boolean): Promise<TomorrowPlan | undefined> | undefined {
    const { tomorrow } = checkinScheduleClock(at);
    if (!canRun(snapshot) || checkinScheduleClock(now()).tomorrow !== tomorrow ||
        (prepared?.date === tomorrow && prepared.config === snapshot)) return;
    const pending = forcedPlan ?? preparation;
    if (pending) return scheduled ? pending.catch(() => undefined).then(() => prepare(snapshot, at, true)) : pending;
    preparation = (async () => {
      if (!scheduled && await store.read(tomorrow)) return;
      return prepareTomorrow(await listProfiles(), snapshot, at, scheduled ? "scheduled" : "catch-up");
    })().catch(() => {
      if (canRun(snapshot)) console.warn("[签到计划] 无法准备明日计划。");
      return undefined;
    }).finally(() => { preparation = undefined; });
    return preparation;
  }

  function catchUp() {
    const at = now();
    const threshold = dailySecond(planJob?.rule ?? normalizeCron(config.plan_generate_cron) ?? planCron);
    const clock = checkinScheduleClock(at);
    if (threshold !== undefined && clock.minute * 60 + Math.floor(at / 1000) % 60 >= threshold) return prepare(config, at, false);
  }

  function trigger(communityRetriesOnly = false) {
    const snapshot = config;
    if (!canRun(snapshot) || operation) return operation;
    operation = (async () => {
      const { date } = checkinScheduleClock(now());
      if (communityRetriesOnly && !await store.read(date)) return;
      const profiles = await listProfiles();
      if (!canRun(snapshot) || (!profiles.some(profile => profile.enabled) && !await store.read(date))) return;
      const scheduler = createCheckinScheduler({ store, config: snapshot, listProfiles: async () => profiles, runProfile, onComplete, now });
      return scheduler.tick(signal, { communityRetriesOnly });
    })().catch(() => {
      if (canRun(snapshot)) console.warn("[签到计划] 无法执行本轮自动签到。");
      return { status: "failed" as const };
    }).finally(() => { operation = undefined; });
    return operation;
  }

  function schedule(configured: unknown, fallback: string, name: string, callback: () => unknown) {
    const valid = normalizeCron(configured);
    const job = new Job(`lotus-checkin-${name}-${crypto.randomUUID()}`, () => { void callback(); });
    const use = valid ?? fallback;
    if (configured !== undefined && !valid) console.warn(`[签到计划] ${name} 的 cron 无效，使用默认时间。`);
    const install = (rule: string) => {
      try { return job.schedule({ rule, tz: "Asia/Shanghai" }); } catch { return false; }
    };
    if (install(use)) return { job, rule: use };
    console.warn(`[签到计划] ${name} 的 cron 无效，使用默认时间。`);
    return { job: install(fallback) ? job : undefined, rule: fallback };
  }

  function schedulePlan() {
    planJob?.job?.cancel();
    const scheduled = schedule(config.plan_generate_cron, planCron, "明日计划", () => {
      if (planJob === scheduled) void prepare(config, now(), true);
    });
    planJob = scheduled;
  }

  return {
    get enabled() { return config.enable !== false; },
    updateConfig(next: CheckinScheduleConfig) {
      if (isDeepStrictEqual(next, config)) return;
      const rule = normalizeCron(config.plan_generate_cron) ?? planCron;
      config = structuredClone(next);
      if (started && !stopped && !signal.aborted && rule !== (normalizeCron(config.plan_generate_cron) ?? planCron)) schedulePlan();
    },
    runDue: trigger,
    generateTomorrow() {
      const snapshot = config;
      const at = now();
      if (!canRun(snapshot, true)) return;
      return forcedPlan ??= Promise.resolve(preparation).then(() => listProfiles())
        .then(profiles => prepareTomorrow(profiles, snapshot, at, "manual")).finally(() => { forcedPlan = undefined; });
    },
    start() {
      if (!canRun(config) || started) return;
      started = true;
      const due = schedule(config.run_due_cron, dueCron, "到期任务", trigger);
      const fallback = schedule(config.catch_up_cron, "0 */10 * * * *", "计划补偿", catchUp);
      const finalRetry = schedule(undefined, "0 50,59 23 * * *", "签到补跑", () =>
        operation ? operation.then(() => trigger(true)) : trigger(true));
      if (due.job) jobs.push(due.job);
      if (fallback.job) jobs.push(fallback.job);
      if (finalRetry.job) jobs.push(finalRetry.job);
      immediateDue = due.rule === dueCron;
      schedulePlan();
      void catchUp();
      if (immediateDue) void trigger();
    },
    async stop() {
      stopped = true;
      planJob?.job?.cancel();
      for (const job of jobs) job.cancel();
      jobs.length = 0;
      await Promise.allSettled([operation, preparation, forcedPlan]);
    },
    async addRegisteredProfile(profile: CheckinScheduleProfile) {
      const snapshot = config;
      if (!canRun(snapshot)) return;
      const at = now();
      const { date, tomorrow } = checkinScheduleClock(at);
      for (const day of [date, tomorrow]) {
        const updated = await store.update(day, plan => {
          if (!plan || !canRun(snapshot)) return { result: undefined };
          const result = addLateCheckinScheduleProfile(plan, profile, { config: snapshot, now: at });
          const changed = result.plan ?? plan;
          return { plan: changed, result: "entry" in result ? { ...changed, entries: [result.entry] } : undefined };
        });
        if (updated && snapshot.late_registration?.notify !== false) await notifyPlanned(updated, snapshot, true);
      }
      if (preparation) void preparation.then(catchUp);
      else void catchUp();
      if (immediateDue) {
        if (operation) void operation.then(() => trigger());
        else void trigger();
      }
    },
    async personalTomorrow(qq: string, profiles: readonly CheckinScheduleProfile[]) {
      const snapshot = config;
      const at = now();
      const { tomorrow } = checkinScheduleClock(at);
      if (!await store.read(tomorrow)) return;
      return store.update(tomorrow, previous => {
        if (!previous || signal.aborted) return { result: undefined };
        let plan = previous;
        if (canRun(snapshot)) {
          for (const profile of profiles) {
            if (profile.qq === qq && profile.enabled) {
              plan = addLateCheckinScheduleProfile(plan, profile, { config: snapshot, now: at }).plan ?? plan;
            }
          }
        }
        const result = { ...plan, entries: plan.entries.filter(entry => entry.qq === qq) };
        return { plan, result };
      });
    },
    async reconcileExistingPlans() {
      const snapshot = config;
      if (!canRun(snapshot)) return;
      const profiles = await listProfiles();
      const at = now();
      const { date, tomorrow } = checkinScheduleClock(at);
      for (const day of [date, tomorrow]) {
        if (!canRun(snapshot) || !await store.read(day)) continue;
        await store.update(day, current => ({
          plan: current && canRun(snapshot) ? reconcileCheckinSchedulePlan(current, { config: snapshot, now: at, profiles }) : undefined,
          result: undefined,
        }));
      }
    },
  };
}
