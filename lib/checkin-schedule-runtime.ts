import { Job } from "node-schedule";
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

function normalizeCron(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return;
  const fields = value.trim().split(/\s+/u);
  if (fields.length === 7 && fields[6] === "*") fields.pop();
  if (fields.length === 5) fields.unshift("0");
  if (fields.length !== 6) return;
  for (const index of [3, 5]) if (fields[index] === "?") fields[index] = "*";
  return fields.join(" ");
}

export function createCheckinScheduleRuntime({ store, config, listProfiles, signal, runProfile, onComplete, onNotice }: Runner & {
  readonly store: Store;
  readonly config: CheckinScheduleConfig;
  readonly listProfiles: () => Promise<readonly CheckinScheduleProfile[]>;
  readonly signal: AbortSignal;
  readonly onNotice?: PlanNotice;
}) {
  const jobs: Job[] = [];
  let operation: Promise<RuntimeTick | undefined> | undefined;
  let preparation: Promise<TomorrowPlan | undefined> | undefined;
  let forcedPlan: Promise<TomorrowPlan | undefined> | undefined;
  let tomorrowPrepared = "";
  let stopped = false;
  let immediateDue = false;

  function canRun(force = false) {
    return !stopped && !signal.aborted && (force || config.enable !== false);
  }

  async function notifyPlanned(plan: CheckinSchedulePlan, late: boolean, force = false) {
    if (!canRun(force) || !onNotice) return;
    return notifyCheckinPlan(store, plan, (slot, date) => onNotice(slot, date, late, async () => {
      if (!canRun(force)) return false;
      const clock = checkinScheduleClock();
      if (date !== clock.tomorrow && (!late || date !== clock.date)) return false;
      const current = await store.read(date);
      return current?.generatedAt === plan.generatedAt && current.entries.some(entry =>
        entry.qq === slot.qq && entry.profileId === slot.profileId && entry.time === slot.time && entry.mode === slot.mode &&
        entry.noticeAttemptedAt === slot.noticeAttemptedAt && !entry.notified && !entry.done);
    }), signal);
  }

  async function prepareTomorrow(profiles: readonly CheckinScheduleProfile[], force = false): Promise<TomorrowPlan | undefined> {
    const now = Date.now();
    const { tomorrow } = checkinScheduleClock(now);
    if (!canRun(force) || (!force && !profiles.some(profile => profile.enabled) && !await store.read(tomorrow))) return;
    const saved = await store.update(tomorrow, previous => {
      if (!canRun(force) || checkinScheduleClock().tomorrow !== tomorrow) return { result: undefined };
      const plan = previous && !force ? reconcileCheckinSchedulePlan(previous, { now, profiles, config }) :
        generateCheckinSchedulePlan({ date: tomorrow, now, profiles, config });
      return { plan, result: plan };
    });
    if (!saved) return;
    tomorrowPrepared = tomorrow;
    const notices = force || config.random?.notify_before !== false ? await notifyPlanned(saved, false, force) : undefined;
    return { plan: saved, notices };
  }

  function prepare() {
    if (forcedPlan) return forcedPlan;
    if (!canRun() || preparation || tomorrowPrepared === checkinScheduleClock().tomorrow) return preparation;
    preparation = listProfiles().then(profiles => prepareTomorrow(profiles)).catch(() => {
      if (canRun()) console.warn("[签到计划] 无法准备明日计划。");
      return undefined;
    }).finally(() => { preparation = undefined; });
    return preparation;
  }

  function trigger() {
    if (!canRun() || operation) return operation;
    operation = (async () => {
      const { date } = checkinScheduleClock();
      const profiles = await listProfiles();
      if (!canRun() || (!profiles.some(profile => profile.enabled) && !await store.read(date))) return;
      const scheduler = createCheckinScheduler({ store, config, listProfiles: async () => profiles, runProfile, onComplete });
      return scheduler.tick(signal);
    })().catch(() => {
      if (canRun()) console.warn("[签到计划] 无法执行本轮自动签到。");
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
    if (install(use)) {
      jobs.push(job);
      return use;
    }
    console.warn(`[签到计划] ${name} 的 cron 无效，使用默认时间。`);
    if (install(fallback)) jobs.push(job);
    return fallback;
  }

  return {
    enabled: config.enable !== false,
    runDue: trigger,
    generateTomorrow() {
      if (!canRun(true)) return;
      return forcedPlan ??= Promise.resolve(preparation).then(listProfiles)
        .then(profiles => prepareTomorrow(profiles, true)).finally(() => { forcedPlan = undefined; });
    },
    start() {
      if (!canRun() || jobs.length) return;
      immediateDue = schedule(config.run_due_cron, dueCron, "到期任务", trigger) === dueCron;
      schedule(config.plan_generate_cron, "0 0 0 * * *", "明日计划", prepare);
      schedule(config.catch_up_cron, "0 */10 * * * *", "计划补偿", prepare);
      void prepare();
      if (immediateDue) void trigger();
    },
    async stop() {
      stopped = true;
      for (const job of jobs) job.cancel();
      jobs.length = 0;
      await Promise.allSettled([operation, preparation, forcedPlan]);
    },
    async addRegisteredProfile(profile: CheckinScheduleProfile) {
      if (!canRun()) return;
      const now = Date.now();
      const { date, tomorrow } = checkinScheduleClock(now);
      for (const day of [date, tomorrow]) {
        const updated = await store.update(day, plan => {
          if (!plan || !canRun()) return { result: undefined };
          const result = addLateCheckinScheduleProfile(plan, profile, { config, now });
          const changed = result.plan ?? plan;
          return { plan: changed, result: "entry" in result ? { ...changed, entries: [result.entry] } : undefined };
        });
        if (updated && config.late_registration?.notify !== false) await notifyPlanned(updated, true);
      }
      if (preparation) void preparation.then(() => prepare());
      else void prepare();
      if (immediateDue) {
        if (operation) void operation.then(() => trigger());
        else void trigger();
      }
    },
    async personalTomorrow(qq: string, profiles: readonly CheckinScheduleProfile[]) {
      const now = Date.now();
      const { tomorrow } = checkinScheduleClock(now);
      if (!await store.read(tomorrow)) return;
      return store.update(tomorrow, previous => {
        if (!previous || signal.aborted) return { result: undefined };
        let plan = previous;
        if (canRun()) {
          for (const profile of profiles) {
            if (profile.qq === qq && profile.enabled) {
              plan = addLateCheckinScheduleProfile(plan, profile, { config, now }).plan ?? plan;
            }
          }
        }
        const result = { ...plan, entries: plan.entries.filter(entry => entry.qq === qq) };
        return { plan, result };
      });
    },
  };
}
