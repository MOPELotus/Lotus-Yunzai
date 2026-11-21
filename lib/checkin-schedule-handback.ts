import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ProfileAccountContext } from "@lotus-yunzai/account";
import { checkinHandbackHoldStage, checkinScheduleClock, type CheckinScheduleEntry, type CheckinSchedulePlan } from "./checkin-schedule-plan.ts";

export const checkinHandbackVersions = ["e28c6df", "5aa3a70"] as const;
type LegacyVersion = typeof checkinHandbackVersions[number];

type Entry = CheckinScheduleEntry;
type Retry = NonNullable<Entry["communityRetry"]>;
type GetAccount = (qq: string, profileId: number) => Promise<ProfileAccountContext | undefined>;

function entryKey({ qq, profileId }: Entry) {
  return `${qq}/${profileId}`;
}

function settled({ runningAt: _running, communityRetry: _retry, communityWrites: _writes, communityWriteAccount: _owner, ...entry }: Entry) {
  return entry;
}

function held(entry: Entry): Entry {
  return { ...settled(entry), done: true, ok: false, stage: checkinHandbackHoldStage, message: "交还时签到结果待核对。" };
}

function hasProgress(entry: Entry) {
  return !!(entry.runningAt || entry.communityRetry || entry.communityWrites || entry.communityWriteAccount ||
    entry.doneAt || entry.ok !== undefined || entry.stage);
}

function canRetryForum(status: Entry["communityWrites"], forum: string) {
  return status?.[forum] === undefined || status[forum] === "retryable";
}

function hash(fields: readonly unknown[]) {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function matchesAccount(entry: Entry, retry: Retry, current: ProfileAccountContext | undefined) {
  if (!current || current.qq !== entry.qq || current.profileId !== entry.profileId) return false;
  const { stuid, ltuid, mid } = current.account;
  if ((!stuid && !ltuid) || (stuid && ltuid && stuid !== ltuid)) return false;
  const identity = [entry.qq, entry.profileId, stuid || ltuid];
  return retry.accountKey === hash(identity) || retry.accountKey === hash([...identity, mid]);
}

/** Supply accountAtExecution only from a guardian of the actual old run, after matching its pending call. */
export async function prepareLegacyCheckinSchedule(
  source: CheckinSchedulePlan, legacy: CheckinSchedulePlan | undefined, target: LegacyVersion,
  { now = Date.now(), accountAtExecution }: { readonly now?: number; readonly accountAtExecution?: GetAccount } = {},
) {
  if (legacy && legacy.date !== source.date) throw new Error("新旧签到计划日期不一致。");
  const today = checkinScheduleClock(now).date;
  const earlier = new Map(legacy?.entries.map(entry => [entryKey(entry), entry]));
  const currentEntries = new Set(source.entries.map(entryKey));
  const counts = { completed: 0, unstarted: 0, held: 0, heldRetries: 0, unsupportedGames: 0, pendingGames: 0, pendingForums: 0 };
  const entries: Entry[] = [];
  for (const candidate of [...source.entries, ...(legacy?.entries.filter(entry => !currentEntries.has(entryKey(entry))) ?? [])]) {
    const previous = earlier.get(entryKey(candidate));
    const retry = candidate.communityRetry;
    if (candidate.done || previous?.done) {
      counts.completed++;
      entries.push(settled(candidate.done ? candidate : previous!));
      continue;
    }
    if (target === "e28c6df") counts.unsupportedGames += retry?.games?.length ?? 0;
    if (candidate.runningAt || (previous && hasProgress(previous) && !isDeepStrictEqual(previous, candidate))) {
      counts.held++;
      if (retry || previous?.communityRetry) counts.heldRetries++;
      entries.push(held(candidate));
      continue;
    }
    if (retry) {
      // The fixed legacy readers cannot enforce account identity on their own.
      // Keep a mixed retry together if the old reader cannot reconcile its game targets.
      const representable = target === "5aa3a70" || !retry.games?.length;
      const current = representable && accountAtExecution && source.date === today && retry.verifiedUnsent &&
        checkinScheduleClock(Date.parse(retry.nextAt)).date === today &&
        await accountAtExecution(candidate.qq, candidate.profileId);
      if (current && matchesAccount(candidate, retry, current)) {
        const forums = retry.forums.filter(forum => canRetryForum(candidate.communityWrites, forum));
        const games = retry.games;
        if (forums.length || games?.length) {
          counts.pendingForums += forums.length;
          counts.pendingGames += games?.length ?? 0;
          const unresolved = Object.values(candidate.communityWrites ?? {}).some(status =>
            status === "pending" || status === "unconfirmed" || status === "rejected" || status === "blocked");
          entries.push({ ...settled(candidate), communityRetry: {
            forums, ...(games?.length && { games }), attempts: retry.attempts, nextAt: retry.nextAt,
            ...(retry.otherFailure || unresolved ? { otherFailure: true } : {}),
          } });
          continue;
        }
      }
      counts.held++;
      counts.heldRetries++;
      entries.push(held(candidate));
    } else if (hasProgress(candidate) || source.date < today) {
      counts.held++;
      entries.push(held(candidate));
    } else {
      counts.unstarted++;
      entries.push(settled(candidate));
    }
  }
  return { plan: { ...source, entries }, counts };
}
