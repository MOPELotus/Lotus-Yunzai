import {
  checkinScheduleClock, checkinScheduleMinute, generateCheckinSchedulePlan, reconcileCheckinSchedulePlan,
  type CheckinScheduleConfig, type CheckinScheduleEntry, type CheckinScheduleProfile,
} from "./checkin-schedule-plan.ts";
import type { createCheckinScheduleStore } from "./checkin-schedule-store.ts";
import type { MessageReply } from "./messages.ts";

const stages = ["precheck", "refresh", "runner", "checkin", "schedule"] as const;

interface CheckinScheduledCompletion {
  readonly status: "complete";
  readonly ok: boolean;
  readonly stage: typeof stages[number];
  readonly reply?: MessageReply;
  readonly revision?: string;
}

export type CheckinScheduledOutcome = { readonly status: "busy" } | CheckinScheduledCompletion;

export interface CheckinScheduledRunContext {
  readonly date: string;
  readonly signal: AbortSignal;
  readonly verifyDay: () => void;
}

interface SchedulerOptions {
  readonly store: Pick<ReturnType<typeof createCheckinScheduleStore>, "update" | "withExecutionLock">;
  readonly config: CheckinScheduleConfig;
  readonly listProfiles: (signal: AbortSignal) => Promise<readonly CheckinScheduleProfile[]>;
  // Recheck the live registration and revision before side effects. If stale, return busy.
  readonly runProfile: (entry: CheckinScheduleEntry, context: CheckinScheduledRunContext) => Promise<CheckinScheduledOutcome>;
  readonly onComplete?: (entry: CheckinScheduleEntry, result: CheckinScheduledCompletion) => void | Promise<void>;
  readonly now?: () => Date | number;
  readonly random?: () => number;
}

interface TickResult {
  readonly date: string;
  readonly status: "disabled" | "locked" | "complete" | "interrupted";
  readonly completed: number;
  readonly deferred: number;
}

function sameProfile(left: CheckinScheduleEntry, right: CheckinScheduleEntry) {
  return left.qq === right.qq && left.profileId === right.profileId;
}

function due(entry: CheckinScheduleEntry, minute: number) {
  return !entry.done && !entry.runningAt && !entry.communityRetry && checkinScheduleMinute(entry.time) <= minute;
}

function clearRunning(entry: CheckinScheduleEntry): CheckinScheduleEntry {
  const { runningAt: _runningAt, ...rest } = entry;
  return rest;
}

export function createCheckinScheduler({ store, config, listProfiles, runProfile, onComplete, now = Date.now, random }: SchedulerOptions) {
  async function tick(shutdown?: AbortSignal): Promise<TickResult> {
    const started = now();
    const clock = checkinScheduleClock(started);
    const { date } = clock;
    let completed = 0;
    let deferred = 0;
    const result = (status: TickResult["status"]): TickResult => ({ date, status, completed, deferred });
    if (shutdown?.aborted) return result("interrupted");
    if (config.enable === false) return result("disabled");

    const day = new AbortController();
    const midnight = Date.parse(`${clock.tomorrow}T00:00:00+08:00`);
    const expiry = setTimeout(() => day.abort(), midnight - Number(started));
    expiry.unref();
    const signal = shutdown ? AbortSignal.any([shutdown, day.signal]) : day.signal;
    function verifyDay() {
      if (checkinScheduleClock(now()).date !== date) day.abort();
      signal.throwIfAborted();
    }
    const context = { date, signal, verifyDay };
    try {
      const lock = await store.withExecutionLock(date, async () => {
        verifyDay();
        const profiles = await listProfiles(signal);
        const planned = await store.update(date, previous => {
          verifyDay();
          const observed = now();
          const valid = previous && { ...previous, entries: previous.entries.map(clearRunning) };
          const plan = valid
            ? reconcileCheckinSchedulePlan(valid, { config, profiles, now: observed })
            : generateCheckinSchedulePlan({ config, profiles, now: observed, date, random });
          return { plan, result: plan };
        });
        for (const pending of planned.entries) {
          verifyDay();
          if (!due(pending, checkinScheduleClock(now()).minute)) continue;
          const claim = await store.update<CheckinScheduleEntry | undefined>(date, plan => {
            verifyDay();
            const at = checkinScheduleClock(now());
            const entry = plan?.entries.find(item => sameProfile(item, pending));
            if (!plan || !entry || !due(entry, at.minute)) return { result: undefined };
            const running = { ...entry, runningAt: at.iso };
            return { plan: { ...plan, entries: plan.entries.map(item => item === entry ? running : item) }, result: running };
          });
          if (!claim) continue;
          verifyDay();
          let outcome: CheckinScheduledOutcome;
          try {
            outcome = await runProfile(claim, context);
          } catch {
            // The request may have been sent. Leave the claim for a later read-backed recovery.
            return result("interrupted");
          }
          verifyDay();
          if (outcome?.status !== "busy" &&
              (outcome?.status !== "complete" || typeof outcome.ok !== "boolean" || !stages.includes(outcome.stage))) {
            return result("interrupted");
          }
          const settled = await store.update<CheckinScheduleEntry | undefined>(date, plan => {
            verifyDay();
            const entry = plan?.entries.find(item => sameProfile(item, claim));
            if (!plan || !entry || entry.runningAt !== claim.runningAt || entry.done || entry.communityRetry) return { result: undefined };
            const ready = clearRunning(entry);
            const next = outcome.status === "busy" ? ready : {
              ...ready, done: true, doneAt: checkinScheduleClock(now()).iso, stage: outcome.stage, ok: outcome.ok,
              message: outcome.ok ? "自动签到已完成。" : "自动签到有未完成的项目。",
            };
            return { plan: { ...plan, entries: plan.entries.map(item => item === entry ? next : item) }, result: next };
          });
          if (!settled) continue;
          if (outcome.status === "busy") {
            deferred++;
          } else {
            completed++;
            verifyDay();
            try {
              await onComplete?.(settled, outcome);
            } catch {
              // Delivery failure cannot reopen a completed check-in.
            }
          }
        }
        return result("complete");
      });
      return lock.acquired ? lock.value : result("locked");
    } catch (error) {
      if (signal.aborted) return result("interrupted");
      throw error;
    } finally {
      clearTimeout(expiry);
    }
  }
  return { tick };
}
