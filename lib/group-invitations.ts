import { createHash } from "node:crypto";
import { readLocalConfig } from "./config.ts";
import type { GroupRequest } from "./messages.ts";

export type GroupInvitationResult = "confirmed" | "rejected" | "unknown" | "skip" | "duplicate";

export async function readGroupInvitations(root: URL) {
  const { autoGroup } = await readLocalConfig(root, "other");
  const masterOnly = autoGroup === 0 || autoGroup === "0";
  const allInviters = autoGroup === 1 || autoGroup === "1";
  const inFlightOrUnknown = new Set<string>();
  const settled = new Set<string>();
  const maxAttempts = 4096;

  return async (event: GroupRequest, signal?: AbortSignal): Promise<GroupInvitationResult> => {
    if ((!allInviters && !masterOnly) || event.sub_type !== "invite" || event.self_id === event.user_id) return "skip";

    const key = createHash("sha256")
      .update(JSON.stringify([event.self_id, event.sub_type, event.group_id, event.flag]))
      .digest("hex");
    if (inFlightOrUnknown.has(key) || settled.has(key)) return "duplicate";
    if (masterOnly && !event.isMaster) return "skip";

    if (signal?.aborted || inFlightOrUnknown.size >= maxAttempts) return "skip";
    inFlightOrUnknown.add(key);

    let result: GroupInvitationResult;
    try {
      const approved = await event.approve(true);
      result = approved === true ? "confirmed" : approved === false ? "rejected" : "unknown";
    } catch (error) {
      result = error instanceof Error && "delivery" in error && error.delivery === "not-sent"
        ? "rejected" : "unknown";
    }
    if (result !== "unknown") {
      inFlightOrUnknown.delete(key);
      settled.add(key);
      if (settled.size > maxAttempts) settled.delete(settled.values().next().value!);
    }
    return result;
  };
}
