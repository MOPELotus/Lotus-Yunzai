import type { FriendPoke, GroupNotice, GroupPoke, MessageReply, MilkyGroupCompatibilityNotice } from "../messages.ts";
import { inspectMilkyAutoQuit, type MilkyAutoQuitCall } from "./milky-auto-quit.ts";

type SendReply = (target: { group_id: number } | { user_id: number }, reply: MessageReply) => Promise<boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function milkyGroupCompatibilityNotice(
  value: unknown, selfId: number, sendReply: SendReply, isMaster: (userId: number) => boolean,
): MilkyGroupCompatibilityNotice | undefined {
  if (!isId(selfId) || !isRecord(value) || value.self_id !== selfId || !isRecord(value.data)) return;
  const { event_type: type, time, data } = value;
  const { group_id, message_seq, new_group_name } = data;
  if (!isId(group_id)) return;
  const operator_id = isId(data.operator_id) ? data.operator_id : undefined;
  const base = {
    post_type: "notice" as const, adapter: "milky" as const, self_id: selfId, group_id, operator_id,
    time: isId(time) ? time : undefined,
    isGroup: true as const, isPrivate: false as const, isMaster: false,
    reply: (reply: MessageReply) => sendReply({ group_id }, reply),
  };
  if (type === "group_name_change" && operator_id !== undefined && typeof new_group_name === "string") {
    return { ...base, notice_type: "group_card", user_id: operator_id, isMaster: isMaster(operator_id), new_group_name,
      old_name: typeof data.old_name === "string" ? data.old_name : undefined,
      new_name: typeof data.new_name === "string" ? data.new_name : undefined };
  }
  if (typeof message_seq !== "number" || !Number.isSafeInteger(message_seq) || message_seq < 0) return;
  if (type === "group_message_reaction") {
    const { face_id, is_add, reaction_type, user_id } = data;
    if (!isId(user_id) || typeof face_id !== "string" || typeof is_add !== "boolean") return;
    return { ...base, notice_type: "group_msg_emoji_like", user_id, isMaster: isMaster(user_id),
      message_id: message_seq, message_seq, face_id, is_add, likes: [{ emoji_id: face_id, count: is_add ? 1 : 0 }],
      reaction_type: reaction_type === "face" || reaction_type === "emoji" ? reaction_type : undefined };
  }
  if (type === "group_essence_message_change" && typeof data.is_set === "boolean") {
    return { ...base, notice_type: "group_essence", sub_type: data.is_set ? "add" : "delete",
      message_id: message_seq, message_seq, is_set: data.is_set };
  }
}

export function milkyNotice(
  value: unknown, selfId: number, call: MilkyAutoQuitCall, sendReply: SendReply, leaveGroup?: (groupId: number) => Promise<boolean>,
): GroupNotice | GroupPoke | FriendPoke | undefined {
  if (!isId(selfId) || !isRecord(value) || value.self_id !== selfId || !isRecord(value.data)) return;
  const { event_type: type, time, data } = value;
  const { user_id, group_id } = data;
  if (type === "group_nudge") {
    const { sender_id, receiver_id } = data;
    if (!isId(group_id) || !isId(sender_id) || !isId(receiver_id)) return;
    return {
      post_type: "notice", notice_type: "group", sub_type: "poke",
      self_id: selfId, group_id, user_id: sender_id, operator_id: sender_id, target_id: receiver_id,
      time: isId(time) ? time : undefined,
      isGroup: true, isPrivate: false, isMaster: false,
      reply: (reply) => sendReply({ group_id }, reply),
    };
  }
  if (!isId(user_id)) return;

  if (type === "friend_nudge") {
    if (user_id === selfId || data.is_self_send !== false || data.is_self_receive !== true) return;
    return {
      post_type: "notice", notice_type: "friend", sub_type: "poke",
      self_id: selfId, user_id, operator_id: user_id, target_id: selfId,
      time: isId(time) ? time : undefined,
      isGroup: false, isPrivate: true, isMaster: false,
      reply: (reply) => sendReply({ user_id }, reply),
    };
  }

  if ((type !== "group_member_increase" && type !== "group_member_decrease") || !isId(group_id)) return;
  const increase = type === "group_member_increase";
  const ownJoin = increase && user_id === selfId && isId(time) && leaveGroup !== undefined;
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
    inspectAutoQuit: ownJoin ? (maxMembers, active) => inspectMilkyAutoQuit(call, group_id, selfId, time, maxMembers, active) : undefined,
    leaveGroup: ownJoin ? () => leaveGroup(group_id) : undefined,
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
