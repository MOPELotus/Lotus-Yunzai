import { createHash } from "node:crypto";
import type { GroupRequest, MessageReply } from "../messages.ts";

interface Callbacks {
  readonly isMaster: (userId: number) => boolean;
  readonly approve: (flag: string, accept: boolean, reason?: string) => Promise<boolean>;
  readonly sendGroup: (groupId: number, reply: MessageReply) => Promise<boolean>;
  readonly sendPrivate: (userId: number, reply: MessageReply) => Promise<boolean>;
  readonly masterIds: readonly number[];
}

type Decision = (accept: boolean, reason?: string) => { action: string; params: Record<string, unknown> } | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function milkyGroupRequest(
  value: unknown, selfId: number, callbacks: Callbacks,
): (GroupRequest & { readonly decision: Decision }) | undefined {
  if (!isId(selfId) || !isRecord(value) || value.self_id !== selfId || !isRecord(value.data)) return;
  const { event_type: type, data } = value;
  if (type !== "group_join_request" && type !== "group_invited_join_request" && type !== "group_invitation") return;
  const { group_id: groupId, initiator_id: initiatorId } = data;
  const invitation = type === "group_invitation";
  const thirdParty = type === "group_invited_join_request";
  const userId = thirdParty ? data.target_user_id : initiatorId;
  const sequence = invitation ? data.invitation_seq : data.notification_seq;
  if (!isId(groupId) || !isId(initiatorId) || !isId(userId) || userId === selfId || !isId(sequence)) return;
  if (type === "group_join_request" && typeof data.is_filtered !== "boolean") return;

  const filtered = type === "group_join_request" && data.is_filtered === true;
  const digest = createHash("sha256").update(JSON.stringify([selfId, type, groupId, sequence, filtered])).digest("hex");
  const flag = `milky:group:${digest}`;
  const recipients = [...new Set(callbacks.masterIds.filter((id) => isId(id) && id !== selfId))];
  const decision: Decision = (accept, reason) => {
    if (typeof accept !== "boolean") return;
    if (invitation) {
      return {
        action: accept ? "accept_group_invitation" : "reject_group_invitation",
        params: { group_id: groupId, invitation_seq: sequence },
      };
    }
    if (!accept && reason !== undefined && (typeof reason !== "string" || reason.length > 512)) return;
    return {
      action: accept ? "accept_group_request" : "reject_group_request",
      params: {
        group_id: groupId, notification_seq: sequence, is_filtered: filtered,
        notification_type: thirdParty ? "invited_join_request" : "join_request",
        ...(!accept && reason !== undefined ? { reason } : {}),
      },
    };
  };

  let submitted = false;
  const request: GroupRequest & { readonly decision: Decision } = {
    post_type: "request", request_type: "group", sub_type: invitation ? "invite" : "add",
    self_id: selfId, user_id: userId, group_id: groupId, flag, groupRequestScope: "milky",
    inviter_id: invitation || thirdParty ? initiatorId : undefined,
    comment: type === "group_join_request" && typeof data.comment === "string" ? data.comment : undefined,
    isGroup: true, isPrivate: false, isMaster: invitation && callbacks.isMaster(initiatorId) === true,
    decision,
    async approve(accept = true, reason) {
      if (submitted || !decision(accept, reason)) return false;
      submitted = true;
      const confirmed = await callbacks.approve(flag, accept, !accept && !invitation ? reason : undefined);
      if (confirmed === false) submitted = false;
      return confirmed;
    },
    replyToApplicant: invitation ? (reply) => callbacks.sendPrivate(initiatorId, reply) : undefined,
    reply: (reply) => callbacks.sendGroup(groupId, reply),
    async notifyMasters(message) {
      if (typeof message !== "string" || !message) return 0;
      const outcomes = await Promise.allSettled(recipients.map(async (id) => callbacks.sendPrivate(id, message)));
      return outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value === true).length;
    },
  };
  Object.defineProperty(request, "decision", { enumerable: false, configurable: false, writable: false });
  return request;
}
