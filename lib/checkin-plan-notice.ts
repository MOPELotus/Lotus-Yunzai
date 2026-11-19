import type { CheckinNotifyResult } from "./checkin-notify.ts";
import { checkinScheduleClock, type CheckinScheduleEntry, type CheckinSchedulePlan } from "./checkin-schedule-plan.ts";
import type { createCheckinScheduleStore } from "./checkin-schedule-store.ts";

function matchingSlot(left: CheckinScheduleEntry, right: CheckinScheduleEntry) {
  return left.qq === right.qq && left.profileId === right.profileId && left.time === right.time && left.mode === right.mode;
}

export async function notifyCheckinPlan(
  store: Pick<ReturnType<typeof createCheckinScheduleStore>, "update">,
  plan: CheckinSchedulePlan,
  deliver: (entry: CheckinScheduleEntry, date: string) => Promise<Pick<CheckinNotifyResult, "status">>,
  signal?: AbortSignal,
) {
  const { date, generatedAt } = plan;
  const counts = { confirmed: 0, unknown: 0, unavailable: 0, skipped: 0 };
  for (const entry of plan.entries) {
    if (signal?.aborted) break;
    if (entry.notified || entry.noticeAttemptedAt || entry.done) {
      counts.skipped++;
      continue;
    }
    async function changeSlot(
      change: (current: CheckinScheduleEntry) => CheckinScheduleEntry | undefined,
    ): Promise<CheckinScheduleEntry | undefined> {
      return store.update(date, current => {
        if (signal?.aborted || current?.date !== date || current.generatedAt !== generatedAt) return { result: undefined };
        const existing = current.entries.find(item => matchingSlot(item, entry));
        const next = existing && change(existing);
        if (!next) return { result: undefined };
        return { plan: { ...current, entries: current.entries.map(item => item === existing ? next : item) }, result: next };
      });
    }
    const claim = await changeSlot(existing => {
      if (existing.notified || existing.noticeAttemptedAt || existing.done) return;
      return { ...existing, noticeAttemptedAt: checkinScheduleClock().iso };
    });
    if (!claim) {
      counts.skipped++;
      continue;
    }
    if (signal?.aborted) {
      counts.unknown++;
      break;
    }
    let status: CheckinNotifyResult["status"] | undefined;
    try {
      status = (await deliver(claim, date))?.status;
    } catch {
      // A thrown delivery may have already reached its recipient.
    }
    if (signal?.aborted || (status !== "confirmed" && status !== "skipped" && status !== "unavailable")) {
      counts.unknown++;
      continue;
    }
    await changeSlot(existing => {
      if (existing.noticeAttemptedAt !== claim.noticeAttemptedAt) return;
      const { noticeAttemptedAt: _noticeAttemptedAt, ...rest } = existing;
      return { ...rest, notified: existing.notified || status === "confirmed" };
    });
    counts[status]++;
  }
  return counts;
}
