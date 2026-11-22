import { createHash } from "node:crypto";
import { configuredIds } from "./config.ts";
import { otherPolicySetting, readRequestOtherPolicies, requestAutomationSettings, type RequestOtherPolicies } from "./request-other-policies.ts";
import type { GroupRequest } from "./messages.ts";
import type { RequestDecisionOutcome } from "./request-claim.ts";

export type GroupInvitationResult = "confirmed" | "rejected" | "unknown" | "skip" | "duplicate";

export interface PendingGroupInvitation {
  readonly groupId: number;
  readonly groupName?: string;
  readonly inviterId: number;
  readonly nickname?: string;
}

export interface PendingGroupInvitationList {
  readonly entries: readonly PendingGroupInvitation[];
  readonly complete: boolean;
}

export interface PendingGroupInvitationDecision {
  readonly status: RequestDecisionOutcome | "not-found" | "ambiguous";
  readonly resolvedFlag?: string;
}

export interface QuotedGroupInvitationDecision {
  readonly status: RequestDecisionOutcome | "expired" | "unrelated";
  readonly groupId?: number;
  readonly resolvedFlag?: string;
}

function invitationPolicy(files: ReturnType<RequestOtherPolicies["current"]>) {
  const config = otherPolicySetting(files, "autoGroup");
  const legacy = config && "legacy" in config ? config.legacy : undefined;
  const { autoGroup } = requestAutomationSettings(files);
  const allInviters = autoGroup === "all";
  const masterOnly = autoGroup === "owners";
  const whiteUser = configuredIds(legacy?.whiteUser);
  const blackUser = configuredIds(legacy?.blackUser);
  const whiteGroup = configuredIds(legacy?.whiteGroup);
  const blackGroup = configuredIds(legacy?.blackGroup);
  function admits(event: GroupRequest): boolean {
    return !blackUser.has(event.user_id) && (whiteUser.size === 0 || whiteUser.has(event.user_id)) &&
      !blackGroup.has(event.group_id) && (whiteGroup.size === 0 || whiteGroup.has(event.group_id));
  }
  return { allInviters, masterOnly, admits };
}

export async function readGroupInvitations(root: URL, other?: RequestOtherPolicies) {
  const source = other ?? await readRequestOtherPolicies(root);
  let files = source.current();
  let policy = invitationPolicy(files);
  const inFlightOrUnknown = new Set<string>();
  const settled = new Set<string>();
  const maxAttempts = 4096;

  function currentPolicy() {
    const latest = source.current();
    if (files !== latest) {
      files = latest;
      policy = invitationPolicy(files);
    }
    return policy;
  }

  async function review(event: GroupRequest, signal?: AbortSignal): Promise<GroupInvitationResult> {
    const { allInviters, masterOnly, admits } = currentPolicy();
    if ((!allInviters && !masterOnly) || event.sub_type !== "invite" || event.self_id === event.user_id || !admits(event)) return "skip";

    const key = createHash("sha256")
      .update(JSON.stringify([event.groupRequestScope ?? "onebot", event.self_id, event.group_id, event.flag]))
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
  }

  return { admits: (event: GroupRequest) => currentPolicy().admits(event), review };
}
