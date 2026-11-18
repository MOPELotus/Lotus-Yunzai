import type { MessageEvent } from "../messages.ts";
import type { OneBotCalls } from "./onebot-calls.ts";

interface GroupMute {
  until?: number;
  all?: boolean;
  role?: ReturnType<OneBotCalls["getGroupRole"]>;
}

export class OneBotMutes {
  readonly #groups = new Map<string, GroupMute>();

  observe(groupId: number, selfId: number, event: Record<string, unknown>): void {
    const { notice_type, sub_type, user_id, duration } = event;
    const key = `${selfId}:${groupId}`;
    const state = this.#groups.get(key);
    if (notice_type === "group_decrease" && user_id === selfId) this.#groups.delete(key);
    if (notice_type === "group_admin" && user_id === selfId && state) {
      this.#groups.set(key, { ...state, role: undefined });
    }
    if (notice_type !== "group_ban" || (user_id !== 0 && user_id !== selfId)) return;
    if (sub_type !== "ban" && sub_type !== "lift_ban") return;

    const mute = { ...state };
    if (user_id === 0) {
      mute.all = sub_type === "ban";
      mute.role = undefined;
    } else if (sub_type === "lift_ban") {
      mute.until = undefined;
    } else if (typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0) {
      mute.until = Date.now() + duration * 1_000;
    } else {
      return;
    }
    if (mute.all || mute.until !== undefined) this.#groups.set(key, mute);
    else this.#groups.delete(key);
  }

  async forMessage(groupId: number, selfId: number, lookup: () => ReturnType<OneBotCalls["getGroupRole"]>): Promise<MessageEvent["botMute"]> {
    const key = `${selfId}:${groupId}`;
    const state = this.#groups.get(key);
    if (!state) return;
    const remaining = (state.until ?? 0) - Date.now();
    if (remaining > 0) return { remainingSeconds: remaining / 1_000 };
    if (!state.all) {
      this.#groups.delete(key);
      return;
    }
    const pending = state.role ??= lookup();
    const role = await pending;
    if (this.#groups.get(key) !== state) return this.forMessage(groupId, selfId, lookup);
    if (!role && state.role === pending) state.role = undefined;
    return { allMembers: true, isAdmin: role === "admin", isOwner: role === "owner" };
  }
}
