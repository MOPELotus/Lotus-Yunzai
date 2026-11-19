import type { GroupMembership, MessageEvent } from "../messages.ts";
import type { MilkyConfirmation } from "./milky-api.ts";

type Confirm = (action: string, params: Record<string, unknown>) => Promise<MilkyConfirmation>;
type Role = GroupMembership["botRole"];

interface GroupMute {
  readonly individual?: { readonly time?: number; readonly sourceTime?: number; readonly duration: number; readonly until: number };
  readonly whole?: { readonly time?: number; readonly muted: boolean; role?: Promise<Role | undefined> };
}

const groupLimit = 4_096;
const maxDuration = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function older(time: number | undefined, previous: number | undefined): boolean {
  return time !== undefined && previous !== undefined && time < previous;
}

export function createMilkyGroupMute(account: number, signal: AbortSignal, confirm: Confirm, now: () => number = Date.now) {
  const groups = new Map<number, GroupMute>();
  signal.addEventListener("abort", () => groups.clear(), { once: true });

  function remember(group: number, state: GroupMute) {
    groups.delete(group);
    groups.set(group, state);
    if (groups.size > groupLimit) groups.delete(groups.keys().next().value!);
  }

  function observe(body: unknown): void {
    if (signal.aborted || !isRecord(body) || body.self_id !== account || !isRecord(body.data)) return;
    const { data, event_type: type } = body;
    const { group_id: group, user_id: user } = data;
    if (!isId(group)) return;
    if (type === "group_disband" || (type === "group_member_decrease" && user === account)) {
      groups.delete(group);
      return;
    }

    const state = groups.get(group);
    const received = now();
    const sourceTime = isId(body.time) ? body.time : undefined;
    const time = sourceTime === undefined ? undefined : Math.min(sourceTime, Math.floor(received / 1_000));
    if (type === "group_mute" && user === account) {
      const { duration } = data;
      if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 0 || duration > maxDuration ||
          older(time, state?.individual?.time)) return;
      // Equal timestamps are ordered by arrival, except an identical repeat must not extend an active mute.
      if (sourceTime !== undefined && state?.individual?.sourceTime === sourceTime && state.individual.duration === duration) return;
      const started = sourceTime === undefined ? received : Math.min(received, sourceTime * 1_000);
      const until = duration === 0 ? 0 : started + duration * 1_000;
      remember(group, { ...state, individual: { time, sourceTime, duration, until } });
    } else if (type === "group_whole_mute" && typeof data.is_mute === "boolean") {
      if (older(time, state?.whole?.time)) return;
      if (state?.whole?.muted === data.is_mute && state.whole.time === time) return;
      remember(group, { ...state, whole: { time, muted: data.is_mute } });
    } else if (type === "group_admin_change" && user === account && typeof data.is_set === "boolean" && state?.whole?.muted) {
      if (older(time, state.whole.time)) return;
      remember(group, { ...state, whole: { time: state.whole.time, muted: true } });
    }
  }

  async function lookupRole(groupId: number): Promise<Role | undefined> {
    try {
      const result = await confirm("get_group_member_info", { group_id: groupId, user_id: account, no_cache: true });
      if (result.status !== "confirmed") return;
      const member = result.data.member;
      if (!isRecord(member) || member.group_id !== groupId || member.user_id !== account) return;
      const { role } = member;
      if (role === "member" || role === "admin" || role === "owner") return role;
    } catch {
      return undefined;
    }
  }

  async function forMessage(groupId: number): Promise<MessageEvent["botMute"]> {
    while (!signal.aborted) {
      const state = groups.get(groupId);
      if (!state) return;
      const remaining = (state.individual?.until ?? 0) - now();
      if (remaining > 0) return { remainingSeconds: remaining / 1_000 };
      const { whole } = state;
      if (!whole?.muted) return;

      const pending = whole.role ??= lookupRole(groupId);
      const role = await pending;
      if (groups.get(groupId) !== state || signal.aborted) continue;
      if (role === undefined && whole.role === pending) whole.role = undefined;
      return { allMembers: true, isAdmin: role === "admin", isOwner: role === "owner" };
    }
  }

  return { observe, forMessage };
}
