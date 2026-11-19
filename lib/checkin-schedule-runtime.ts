import { Job } from "node-schedule";
import {
  addLateCheckinScheduleProfile, checkinScheduleClock, generateCheckinSchedulePlan, reconcileCheckinSchedulePlan,
  type CheckinScheduleConfig, type CheckinScheduleProfile,
} from "./checkin-schedule-plan.ts";
import type { createCheckinScheduleStore } from "./checkin-schedule-store.ts";
import { createCheckinScheduler } from "./checkin-scheduler.ts";

type Store = ReturnType<typeof createCheckinScheduleStore>;
type Runner = Pick<Parameters<typeof createCheckinScheduler>[0], "runProfile" | "onComplete">;
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

export function createCheckinScheduleRuntime({ store, config, listProfiles, signal, runProfile, onComplete }: Runner & {
  readonly store: Store;
  readonly config: CheckinScheduleConfig;
  readonly listProfiles: () => Promise<readonly CheckinScheduleProfile[]>;
  readonly signal: AbortSignal;
}) {
  const jobs: Job[] = [];
  let operation: Promise<void> | undefined;
  let preparation: Promise<void> | undefined;
  let tomorrowPrepared = "";
  let stopped = false;
  let immediateDue = false;

  function canRun() {
    return !stopped && !signal.aborted && config.enable !== false;
  }

  async function prepareTomorrow(profiles: readonly CheckinScheduleProfile[]) {
    const now = Date.now();
    const { tomorrow } = checkinScheduleClock(now);
    if (!canRun() || (!profiles.some(profile => profile.enabled) && !await store.read(tomorrow))) return;
    await store.update(tomorrow, previous => {
      if (!canRun()) return { result: undefined };
      const plan = previous ? reconcileCheckinSchedulePlan(previous, { now, profiles, config }) :
        generateCheckinSchedulePlan({ date: tomorrow, now, profiles, config });
      return { plan, result: undefined };
    });
    tomorrowPrepared = tomorrow;
  }

  function prepare() {
    if (!canRun() || preparation || tomorrowPrepared === checkinScheduleClock().tomorrow) return preparation;
    preparation = listProfiles().then(prepareTomorrow).catch(() => {
      if (canRun()) console.warn("[签到计划] 无法准备明日计划。");
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
      await scheduler.tick(signal);
    })().catch(() => {
      if (canRun()) console.warn("[签到计划] 无法执行本轮自动签到。");
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
      await Promise.all([operation, preparation]);
    },
    async addRegisteredProfile(profile: CheckinScheduleProfile) {
      if (!canRun()) return;
      const now = Date.now();
      const { date, tomorrow } = checkinScheduleClock(now);
      for (const day of [date, tomorrow]) {
        await store.update(day, plan => {
          if (!plan || !canRun()) return { result: undefined };
          const result = addLateCheckinScheduleProfile(plan, profile, { config, now });
          return { plan: result.plan ?? plan, result: undefined };
        });
      }
      if (preparation) void preparation.then(() => prepare());
      else void prepare();
      if (immediateDue) {
        if (operation) void operation.then(() => trigger());
        else void trigger();
      }
    },
  };
}
