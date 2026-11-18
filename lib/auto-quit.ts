import { readLocalConfig } from "./config.ts";
import type { GroupNotice } from "./messages.ts";

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function configuredNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value) : value;
  return isPositiveInteger(parsed) ? parsed : undefined;
}

export async function readAutoQuit(root: URL, masterIds: (bot: number) => readonly number[], legacyMasterIds?: () => readonly number[]) {
  const { autoQuit, masterQQ } = await readLocalConfig(root, "other");
  const threshold = configuredNumber(autoQuit);
  const legacyMasters = new Set((Array.isArray(masterQQ) ? masterQQ : [masterQQ])
    .map(configuredNumber).filter((id) => id !== undefined));
  const latest = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();

  return async (event: GroupNotice, signal?: AbortSignal): Promise<boolean> => {
    const { sub_type, self_id, user_id, group_id, time, inspectAutoQuit, leaveGroup } = event;
    if (threshold === undefined || signal?.aborted || sub_type !== "increase" || self_id !== user_id ||
        !isPositiveInteger(self_id) || !isPositiveInteger(group_id) || !isPositiveInteger(time) ||
        typeof inspectAutoQuit !== "function" || typeof leaveGroup !== "function") return false;

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
      const snapshot = await inspectAutoQuit(threshold);
      if (signal?.aborted || !snapshot || (snapshot.botRole !== "member" && snapshot.botRole !== "admin")) return false;

      const { memberIds } = snapshot;
      if (!Array.isArray(memberIds) || memberIds.length > threshold) return false;
      const members = new Set(memberIds);
      if (members.size !== memberIds.length || !members.has(self_id) || ![...members].every(isPositiveInteger) ||
          (legacyMasterIds ? legacyMasterIds().some((id) => members.has(id)) : memberIds.some((id) => legacyMasters.has(id))) ||
          masterIds(self_id).some((id) => members.has(id))) return false;

      if (signal?.aborted || latest.get(key) !== time) return false;
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
