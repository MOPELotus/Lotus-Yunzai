import type { GroupRequest, GroupRequestType } from "../messages.ts";
import type { MilkyConfirmation } from "./milky-api.ts";

type Decision = (approve: boolean, reason?: string) => { action: string; params: Record<string, unknown> } | undefined;

interface Entry {
  readonly account: number;
  readonly kind: GroupRequestType;
  readonly decision: Decision;
  state: "pending" | "sending" | "completed" | "unknown";
}

export function createMilkyGroupReviews() {
  const requests = new Map<string, Entry>();
  const maxRequests = 4096;
  const unconfirmed = () => new Error("Milky 群请求审批结果未确认。");

  function register(request: Pick<GroupRequest, "self_id" | "sub_type" | "flag">, decision: Decision): boolean {
    const existing = requests.get(request.flag);
    if (existing) return existing.state === "pending";
    if (requests.size >= maxRequests) {
      const settled = [...requests].find(([, { state }]) => state === "completed" || state === "unknown");
      if (!settled) return false;
      requests.delete(settled[0]);
    }
    requests.set(request.flag, {
      account: request.self_id, kind: request.sub_type, decision, state: "pending",
    });
    return true;
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

  return { register, review };
}
