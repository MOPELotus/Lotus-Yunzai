import type { GroupRequest, GroupRequestType } from "../messages.ts";
import type { PendingGroupInvitation, PendingGroupInvitationList } from "../group-invitations.ts";
import type { MilkyConfirmation } from "./milky-api.ts";

type Decision = (approve: boolean, reason?: string) => { action: string; params: Record<string, unknown> } | undefined;

interface Entry {
  readonly account: number;
  readonly kind: GroupRequestType;
  readonly decision: Decision;
  readonly invitation?: PendingGroupInvitation;
  readonly observedAt: number;
  state: "pending" | "sending" | "completed" | "unknown";
}

const observedLifetime = 60 * 60 * 1_000;

export function createMilkyGroupReviews() {
  const requests = new Map<string, Entry>();
  const maxRequests = 4096;
  const unconfirmed = () => new Error("Milky 群请求审批结果未确认。");

  function register(request: Pick<GroupRequest, "self_id" | "sub_type" | "flag" | "group_id" | "user_id" | "nickname">, decision: Decision): boolean {
    const existing = requests.get(request.flag);
    if (existing) return existing.state === "pending";
    if (requests.size >= maxRequests) {
      const settled = [...requests].find(([, { state }]) => state === "completed" || state === "unknown");
      if (!settled) return false;
      requests.delete(settled[0]);
    }
    requests.set(request.flag, {
      account: request.self_id, kind: request.sub_type, decision, state: "pending",
      invitation: request.sub_type === "invite" ? { groupId: request.group_id, inviterId: request.user_id, nickname: request.nickname } : undefined,
      observedAt: performance.now(),
    });
    return true;
  }

  function listObservedInvitations(account: number): PendingGroupInvitationList {
    const cutoff = performance.now() - observedLifetime;
    const entries: PendingGroupInvitation[] = [];
    for (const entry of requests.values()) {
      if (entry.account === account && entry.state === "pending" && entry.invitation && entry.observedAt >= cutoff) entries.push(entry.invitation);
    }
    return { entries: entries.reverse(), complete: false };
  }

  function selectObservedInvitation(account: number, groupId: number): { status: "pending"; flag: string } |
    { status: "not-found" | "ambiguous" | "unknown" } {
    const cutoff = performance.now() - observedLifetime;
    const matches = [...requests].filter(([, entry]) => entry.account === account && entry.invitation?.groupId === groupId &&
      entry.state !== "completed" && entry.observedAt >= cutoff);
    if (matches.length > 1) return { status: "ambiguous" };
    const [match] = matches;
    if (!match) return { status: "not-found" };
    const [flag, entry] = match;
    return entry.state === "pending" ? { status: "pending", flag } : { status: "unknown" };
  }

  async function review(
    account: number, flag: string, kind: GroupRequestType, approve: boolean, reason: string | undefined,
    invoke: (action: string, params: Record<string, unknown>) => Promise<MilkyConfirmation>,
  ): Promise<boolean> {
    const entry = requests.get(flag);
    if (!entry || entry.account !== account || entry.kind !== kind) return false;
    if (entry.state === "unknown") throw unconfirmed();
    if (entry.state !== "pending") return false;
    const decision = entry.decision(approve, reason);
    if (!decision) return false;
    entry.state = "sending";
    try {
      const result = await invoke(decision.action, decision.params);
      if (result.status === "unknown") throw unconfirmed();
      entry.state = result.status === "confirmed" ? "completed" : "pending";
      return result.status === "confirmed";
    } catch {
      entry.state = "unknown";
      throw unconfirmed();
    }
  }

  return { register, review, listObservedInvitations, selectObservedInvitation };
}
