import { configuredIds } from "./config.ts";
import { otherPolicySetting, readRequestOtherPolicies, type RequestOtherPolicies } from "./request-other-policies.ts";
import type { GroupNotice } from "./messages.ts";
import { readOwnerSnapshot } from "./permissions.ts";

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function configuredNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value) : value;
  return isPositiveInteger(parsed) ? parsed : undefined;
}

function quitPolicy(files: ReturnType<RequestOtherPolicies["current"]>) {
  const config = otherPolicySetting(files, "autoQuit");
  const primary = config && "primary" in config ? config.primary : undefined;
  const legacy = config && "legacy" in config ? config.legacy : undefined;
  const threshold = configuredNumber(legacy ? (Object.hasOwn(legacy, "autoQuit") ? legacy.autoQuit : 50) : primary);
  if (threshold === undefined) return;
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
    try {
      // The adapter may have skipped member lookup when the group exceeded the previous threshold.
      let approved = false;
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
        if (!Array.isArray(memberIds) || memberIds.length > after.threshold) return false;
        const members = new Set(memberIds);
        const botOwners = after.owners?.owners.get(String(self_id));
        if (members.size !== memberIds.length || !members.has(self_id) || ![...members].every(isPositiveInteger) ||
            after.owners?.globalMasters.some(id => members.has(id)) || memberIds.some(id => botOwners?.has(String(id))) ||
            legacyMasterIds?.().some(id => members.has(id)) || masterIds(self_id).some(id => members.has(id))) return false;
        approved = true;
        break;
      }
      if (!approved || signal?.aborted || latest.get(key) !== time) return false;
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
