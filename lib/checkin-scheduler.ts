import {
  checkinScheduleClock, checkinScheduleMinute, generateCheckinSchedulePlan, legacyUnconfirmedStage, reconcileCheckinSchedulePlan,
  type CheckinCommunityWriteStatus, type CheckinScheduleConfig, type CheckinScheduleEntry, type CheckinScheduleProfile,
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
  readonly retryCommunity?: { readonly forums: readonly string[]; readonly otherFailure: boolean; readonly accountKey: string };
}

export type CheckinScheduledOutcome = { readonly status: "busy" } | CheckinScheduledCompletion;

export class CheckinCommunityWriteError extends Error {}

export interface CheckinScheduledRunContext {
  readonly date: string;
  readonly signal: AbortSignal;
  readonly verifyDay: () => void;
  readonly communityRetryForums?: readonly string[];
  readonly communityAccountKey?: string;
  readonly communityWrites?: {
    readonly previous: NonNullable<CheckinScheduleEntry["communityWrites"]>;
    readonly start: (forum: string, accountKey?: string) => Promise<void>;
    readonly settle: (forum: string, status: Exclude<CheckinCommunityWriteStatus, "pending">) => Promise<void>;
  };
}

interface CheckinCommunityRetryAttempt {
  readonly forums: readonly string[];
  readonly number: number;
}

interface SchedulerOptions {
  readonly store: Pick<ReturnType<typeof createCheckinScheduleStore>, "update" | "withExecutionLock">;
  readonly config: CheckinScheduleConfig;
  readonly listProfiles: (signal: AbortSignal) => Promise<readonly CheckinScheduleProfile[]>;
  // Recheck the live registration and revision before side effects. If stale, return busy.
  readonly runProfile: (entry: CheckinScheduleEntry, context: CheckinScheduledRunContext) => Promise<CheckinScheduledOutcome>;
  readonly onComplete?: (entry: CheckinScheduleEntry, result: CheckinScheduledCompletion,
    retry?: CheckinCommunityRetryAttempt) => void | Promise<void>;
  readonly now?: () => Date | number;
  readonly random?: () => number;
}

interface TickResult {
  readonly date: string;
  readonly status: "disabled" | "locked" | "complete" | "interrupted";
  readonly completed: number;
  readonly deferred: number;
  readonly entries: readonly CheckinScheduleEntry[];
}

function sameProfile(left: CheckinScheduleEntry, right: CheckinScheduleEntry) {
  return left.qq === right.qq && left.profileId === right.profileId;
}

function due(entry: CheckinScheduleEntry, date: string, at: number) {
  if (entry.done || entry.runningAt) return false;
  const retry = entry.communityRetry;
  if (retry) {
    const next = Date.parse(retry.nextAt);
    return retry.verifiedUnsent === true && next <= at && checkinScheduleClock(next).date === date;
  }
  return checkinScheduleMinute(entry.time) <= checkinScheduleClock(at).minute;
}

function nextCommunityAttempt(date: string, started: number, settled: number, isRetry: boolean, attempts: number) {
  const cutoff = Date.parse(`${date}T23:50:00+08:00`);
  if (isRetry && started >= cutoff) return;
  const delays = [10, 60, 180];
  const next = settled < cutoff ? Math.min(settled + (delays[attempts] ?? 360) * 60_000, cutoff)
    : Date.parse(`${date}T23:59:00+08:00`);
  if (next > settled) return new Date(next).toISOString();
}

function clearRunning(entry: CheckinScheduleEntry): CheckinScheduleEntry {
  if (entry.stage === legacyUnconfirmedStage) return entry;
  const { runningAt: _runningAt, ...rest } = entry;
  return rest;
}

export function createCheckinScheduler({ store, config, listProfiles, runProfile, onComplete, now = Date.now, random }: SchedulerOptions) {
  async function tick(shutdown?: AbortSignal, { communityRetriesOnly = false } = {}): Promise<TickResult> {
    const started = now();
    const clock = checkinScheduleClock(started);
    const { date } = clock;
    let completed = 0;
    let deferred = 0;
    const entries: CheckinScheduleEntry[] = [];
    const result = (status: TickResult["status"]): TickResult => ({ date, status, completed, deferred, entries });
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
        const enabledProfiles = new Set(profiles.filter(profile => profile.enabled).map(profile => `${profile.qq}/${profile.profileId ?? 1}`));
        const planned = await store.update(date, previous => {
          verifyDay();
          if (communityRetriesOnly) {
            const plan = previous && { ...previous, entries: previous.entries.map(entry =>
              entry.communityRetry?.verifiedUnsent ? clearRunning(entry) : entry) };
            return { plan, result: plan };
          }
          const observed = now();
          const valid = previous && { ...previous, entries: previous.entries.map(clearRunning) };
          const plan = valid
            ? reconcileCheckinSchedulePlan(valid, { config, profiles, now: observed })
            : generateCheckinSchedulePlan({ config, profiles, now: observed, date, random });
          return { plan, result: plan };
        });
        for (const pending of planned?.entries ?? []) {
          verifyDay();
          if (communityRetriesOnly && !pending.communityRetry?.verifiedUnsent) continue;
          if (!due(pending, date, Number(now())) || !enabledProfiles.has(`${pending.qq}/${pending.profileId}`)) continue;
          const claim = await store.update<CheckinScheduleEntry | undefined>(date, plan => {
            verifyDay();
            const at = Number(now());
            const entry = plan?.entries.find(item => sameProfile(item, pending));
            if (!plan || !entry || !due(entry, date, at) ||
                (communityRetriesOnly && !entry.communityRetry?.verifiedUnsent)) return { result: undefined };
            const running = { ...entry, runningAt: checkinScheduleClock(at).iso };
            return { plan: { ...plan, entries: plan.entries.map(item => item === entry ? running : item) }, result: running };
          });
          if (!claim) continue;
          verifyDay();
          const currentClaim = claim;
          async function recordCommunityWrite(forum: string, status: CheckinCommunityWriteStatus, accountKey?: string) {
            try {
              await store.update(date, plan => {
                verifyDay();
                const entry = plan?.entries.find(item => sameProfile(item, currentClaim));
                if (!plan || !entry || entry.runningAt !== currentClaim.runningAt || entry.done) {
                  throw new Error("自动签到档案已失去执行资格。");
                }
                const previous = entry.communityWrites?.[forum];
                const retry = previous === "retryable" && currentClaim.communityRetry?.forums.includes(forum);
                if ((status === "pending" ? previous !== undefined && !retry : previous !== "pending") ||
                    (accountKey && entry.communityWriteAccount && accountKey !== entry.communityWriteAccount)) {
                  throw new Error("社区签到提交记录已变化。");
                }
                const next = { ...entry, communityWrites: { ...entry.communityWrites, [forum]: status },
                  ...(accountKey && { communityWriteAccount: accountKey }) };
                return { plan: { ...plan, entries: plan.entries.map(item => item === entry ? next : item) }, result: undefined };
              });
            } catch {
              throw new CheckinCommunityWriteError("无法确认社区签到提交记录已保存。");
            }
          }
          let outcome: CheckinScheduledOutcome;
          try {
            outcome = await runProfile(claim, {
              ...context,
              communityRetryForums: claim.communityRetry?.forums,
              communityAccountKey: claim.communityRetry?.accountKey ?? claim.communityWriteAccount,
              communityWrites: {
                previous: claim.communityWrites ?? {},
                start: (forum, accountKey) => recordCommunityWrite(forum, "pending", accountKey),
                settle: recordCommunityWrite,
              },
            });
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
            if (!plan || !entry || entry.runningAt !== claim.runningAt || entry.done) return { result: undefined };
            const ready = clearRunning(entry);
            if (outcome.status === "busy") {
              return { plan: { ...plan, entries: plan.entries.map(item => item === entry ? ready : item) }, result: ready };
            }
            const { communityRetry: previous, ...settledEntry } = ready;
            const at = Number(now());
            const attempts = previous ? previous.attempts + 1 : 0;
            const requested = outcome.retryCommunity;
            const nextAt = requested?.forums.length ? nextCommunityAttempt(date, Date.parse(claim.runningAt!), at, !!previous, attempts) : undefined;
            const ok = outcome.ok && !previous?.otherFailure && !nextAt;
            const next: CheckinScheduleEntry = {
              ...settledEntry, done: !nextAt, stage: outcome.stage, ok,
              ...(nextAt && requested ? { communityRetry: {
                forums: requested.forums, attempts, nextAt, verifiedUnsent: true, accountKey: requested.accountKey,
                otherFailure: Boolean(previous?.otherFailure || requested.otherFailure),
              } } : { doneAt: checkinScheduleClock(at).iso }),
              message: nextAt ? "社区签到已安排补跑。" : ok ? "自动签到已完成。" : "自动签到有未完成的项目。",
            };
            return { plan: { ...plan, entries: plan.entries.map(item => item === entry ? next : item) }, result: next };
          });
          if (!settled) continue;
          if (outcome.status === "busy" || !settled.done) {
            deferred++;
          } else completed++;
          if (outcome.status === "busy") continue;
          entries.push(settled);
          verifyDay();
          try {
            const retry = claim.communityRetry;
            await onComplete?.(settled, outcome, retry && { forums: retry.forums, number: retry.attempts + 1 });
          } catch {
            // Delivery failure cannot reopen a saved check-in.
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
