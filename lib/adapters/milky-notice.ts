import type { FriendPoke, GroupNotice, MessageReply } from "../messages.ts";

type MilkyCall = (action: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
type SendReply = (target: { group_id: number } | { user_id: number }, reply: MessageReply) => Promise<boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function milkyNotice(value: unknown, selfId: number, call: MilkyCall, sendReply: SendReply): GroupNotice | FriendPoke | undefined {
  if (!isId(selfId) || !isRecord(value) || value.self_id !== selfId || !isRecord(value.data)) return;
  const { event_type: type, time, data } = value;
  const { user_id, group_id } = data;
  if (!isId(user_id)) return;

  if (type === "friend_nudge") {
    if (user_id === selfId || data.is_self_send !== false || data.is_self_receive !== true) return;
    return {
      post_type: "notice", notice_type: "friend", sub_type: "poke",
      self_id: selfId, user_id, operator_id: user_id, target_id: selfId,
      isGroup: false, isPrivate: true, isMaster: false,
      reply: (reply) => sendReply({ user_id }, reply),
    };
  }

  if ((type !== "group_member_increase" && type !== "group_member_decrease") || !isId(group_id)) return;
  const increase = type === "group_member_increase";
  const operator_id = isId(data.operator_id) ? data.operator_id : undefined;
  const inviter_id = increase && isId(data.invitor_id) ? data.invitor_id : undefined;
  let action: string | undefined;
  if (increase) {
    if (inviter_id !== undefined) action = "invite";
    else if (operator_id !== undefined) action = "approve";
  } else {
    action = operator_id === undefined || operator_id === user_id ? "leave" : "kick";
  }
  return {
    post_type: "notice", notice_type: "group", sub_type: increase ? "increase" : "decrease",
    self_id: selfId, user_id, group_id, operator_id, inviter_id,
    time: isId(time) ? time : undefined,
    action_sub_type: action, increase_type: increase ? action : undefined, decrease_type: increase ? undefined : action,
    dismiss: !increase && typeof data.dismiss === "boolean" ? data.dismiss : undefined,
    isGroup: true, isPrivate: false, isMaster: false,
    async getGroupName() {
      try {
        const group = (await call("get_group_info", { group_id, no_cache: true }))?.group;
        if (!isRecord(group) || group.group_id !== group_id || typeof group.group_name !== "string") return;
        const name = group.group_name;
        if (name.length <= 256 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) return name.trim() || undefined;
      } catch {
        return undefined;
      }
    },
    reply: (reply) => sendReply({ group_id }, reply),
  };
}
