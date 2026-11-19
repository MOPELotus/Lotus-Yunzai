import {
  addLateCheckinScheduleProfile, checkinScheduleClock, generateCheckinSchedulePlan, reconcileCheckinSchedulePlan,
  type CheckinScheduleConfig, type CheckinScheduleProfile,
} from "./checkin-schedule-plan.ts";
import type { createCheckinScheduleStore } from "./checkin-schedule-store.ts";
import { createCheckinScheduler } from "./checkin-scheduler.ts";

type Store = ReturnType<typeof createCheckinScheduleStore>;
type Runner = Pick<Parameters<typeof createCheckinScheduler>[0], "runProfile" | "onComplete">;

export function createCheckinScheduleRuntime({ store, config, listProfiles, signal, runProfile, onComplete }: Runner & {
  readonly store: Store;
  readonly config: CheckinScheduleConfig;
  readonly listProfiles: () => Promise<readonly CheckinScheduleProfile[]>;
  readonly signal: AbortSignal;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let operation: Promise<void> | undefined;
  let tomorrowPrepared = "";
  let stopped = false;

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

  function trigger() {
    if (!canRun() || operation) return operation;
    operation = (async () => {
      const { date, tomorrow } = checkinScheduleClock();
      const profiles = await listProfiles();
      if (tomorrowPrepared !== tomorrow) {
        try {
          await prepareTomorrow(profiles);
        } catch {
          if (canRun()) console.warn("[签到计划] 无法准备明日计划。");
        }
      }
      if (!canRun() || (!profiles.some(profile => profile.enabled) && !await store.read(date))) return;
      const scheduler = createCheckinScheduler({ store, config, listProfiles: async () => profiles, runProfile, onComplete });
      await scheduler.tick(signal);
    })().catch(() => {
      if (canRun()) console.warn("[签到计划] 无法执行本轮自动签到。");
    }).finally(() => { operation = undefined; });
    return operation;
  }

  return {
    enabled: config.enable !== false,
    start() {
      if (!canRun() || timer !== undefined) return;
      timer = setInterval(trigger, 60_000);
      timer.unref();
      void trigger();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await operation;
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
      if (operation) void operation.then(() => trigger());
      else void trigger();
    },
  };
}
