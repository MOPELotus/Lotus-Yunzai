import { configuredIds } from "./config.ts";
import { otherPolicySetting, readRequestOtherPolicies, requestAutomationSettings, type RequestOtherPolicies } from "./request-other-policies.ts";
import type { GroupNotice } from "./messages.ts";
import { readOwnerSnapshot } from "./permissions.ts";

const quitNoticeTimeoutMs = 5_000;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function quitPolicy(files: ReturnType<RequestOtherPolicies["current"]>) {
  const config = otherPolicySetting(files, "autoQuit");
  const legacy = config && "legacy" in config ? config.legacy : undefined;
  const { autoQuit: threshold } = requestAutomationSettings(files);
  if (!threshold) return;
  let owners: ReturnType<typeof readOwnerSnapshot> | undefined;
  try {
    const ownerConfig = legacy ?? files[0] ?? files[1];
    if (ownerConfig) owners = readOwnerSnapshot(ownerConfig);
  } catch {
    // An unreadable owner roster cannot support automatic departure.
    return;
  }
  const blackGroups = configuredIds(legacy?.blackGroup);
  const whiteGroups = configuredIds(legacy?.whiteGroup);
  const blackUsers = configuredIds(legacy?.blackUser);
  const whiteUsers = configuredIds(legacy?.whiteUser);
  return {
    threshold, owners,
    admits(bot: number, group: number) {
      return !blackGroups.has(group) && (whiteGroups.size === 0 || whiteGroups.has(group)) &&
        !blackUsers.has(bot) && (whiteUsers.size === 0 || whiteUsers.has(bot));
    },
  };
}

export async function readAutoQuit(root: URL, masterIds: (bot: number) => readonly number[],
  legacyMasterIds?: () => readonly number[], other?: RequestOtherPolicies) {
  const source = other ?? await readRequestOtherPolicies(root);
  let files = source.current();
  let policy = quitPolicy(files);

  function currentPolicy() {
    const updated = source.current();
    if (files !== updated) {
      files = updated;
      policy = quitPolicy(files);
    }
    return policy;
  }

  const latest = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();

  return async (event: GroupNotice, signal?: AbortSignal): Promise<boolean> => {
    const { sub_type, self_id, user_id, group_id, time, inspectAutoQuit, leaveGroup } = event;
    if (signal?.aborted || sub_type !== "increase" || self_id !== user_id ||
        !isPositiveInteger(self_id) || !isPositiveInteger(group_id) || !isPositiveInteger(time) ||
        typeof inspectAutoQuit !== "function" || typeof leaveGroup !== "function" ||
        !currentPolicy()?.admits(self_id, group_id)) return false;

    const key = `${self_id}:${group_id}`;
    const last = latest.get(key);
    if (last !== undefined && time <= last) return false;
    // Keep the high-water mark even if a leave response never arrives.
    latest.set(key, time);
    const earlier = inFlight.get(key);
    if (earlier) await earlier;
    if (signal?.aborted || latest.get(key) !== time) return false;

    const { promise, resolve } = Promise.withResolvers<void>();
    inFlight.set(key, promise);
    function canLeave(current: ReturnType<typeof quitPolicy>, members: ReadonlySet<number>) {
      if (!current?.admits(self_id, group_id) || members.size > current.threshold) return false;
      const botOwners = current.owners?.owners.get(String(self_id));
      return !current.owners?.globalMasters.some(id => members.has(id)) &&
        ![...members].some(id => botOwners?.has(String(id))) &&
        !legacyMasterIds?.().some(id => members.has(id)) && !masterIds(self_id).some(id => members.has(id));
    }
    try {
      // The adapter may have skipped member lookup when the group exceeded the previous threshold.
      let approved: ReadonlySet<number> | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = currentPolicy();
        if (!before?.admits(self_id, group_id)) return false;
        const snapshot = await inspectAutoQuit(before.threshold, signal);
        await source.refresh();
        if (signal?.aborted || latest.get(key) !== time) return false;
        const after = currentPolicy();
        if (!after?.admits(self_id, group_id)) return false;
        if (!snapshot && after.threshold > before.threshold) continue;
        if (!snapshot || (snapshot.botRole !== "member" && snapshot.botRole !== "admin")) return false;

        const { memberIds } = snapshot;
        if (!Array.isArray(memberIds)) return false;
        const members = new Set(memberIds);
        if (members.size !== memberIds.length || !members.has(self_id) || ![...members].every(isPositiveInteger) ||
            !canLeave(after, members)) return false;
        approved = members;
        break;
      }
      if (!approved || signal?.aborted || latest.get(key) !== time) return false;
      const noticeWait = Promise.withResolvers<void>();
      const finishNotice = () => noticeWait.resolve();
      const timer = setTimeout(finishNotice, quitNoticeTimeoutMs);
      signal?.addEventListener("abort", finishNotice, { once: true });
      try {
        await Promise.race([event.reply("禁止拉群，已自动退出"), noticeWait.promise]);
      } catch {
        // The notification may fail independently of the permitted departure.
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finishNotice);
      }
      if (signal?.aborted || latest.get(key) !== time) return false;
      await source.refresh();
      if (signal?.aborted || latest.get(key) !== time || !canLeave(currentPolicy(), approved)) return false;
      try {
        return await leaveGroup() === true;
      } catch (error) {
        if (!(error instanceof Error && "delivery" in error && error.delivery === "not-sent")) {
          console.warn("[自动退群] 协议端未确认退群结果。");
        }
        return false;
      }
    } catch {
      return false;
    } finally {
      inFlight.delete(key);
      resolve();
    }
  };
}
