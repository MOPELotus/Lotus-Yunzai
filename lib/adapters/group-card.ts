import type { GroupMembership, InboundSegment, MessageEvent, RecallResult } from "../messages.ts";

interface GroupCardSession {
  readonly botId: number;
  readonly groupId?: number;
  readonly message: readonly InboundSegment[];
  readonly active: () => boolean;
  readonly memberRole: (groupId: number, userId: number) => Promise<GroupMembership["botRole"] | undefined>;
  readonly write: (groupId: number, userId: number, card: string) => Promise<RecallResult>;
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function bindGroupCard(session: GroupCardSession): NonNullable<MessageEvent["setGroupCard"]> {
  const { botId, groupId, message, active, memberRole, write } = session;
  const mentions = new Set(message.filter(segment => segment.type === "at").map(({ qq }) =>
    typeof qq === "string" && /^[1-9]\d*$/u.test(qq) ? Number(qq) : qq));
  const otherMentions = [...mentions].filter(id => id !== botId);
  return async (card, requestedGroup, requestedUser) => {
    if (typeof card !== "string" || !active()) return "rejected";
    const targetGroup = groupId ?? requestedGroup;
    const targetUser = requestedUser ?? botId;
    if (!positiveId(targetGroup) || !positiveId(targetUser)) return "rejected";
    if (groupId === undefined) {
      if (requestedUser !== undefined || mentions.size !== 0) return "rejected";
    } else if (requestedGroup !== undefined || otherMentions.length > 1 || otherMentions[0] !== requestedUser) {
      return "rejected";
    }

    const botRole = await memberRole(targetGroup, botId);
    if (!active()) return "rejected";
    if (!botRole) return "missing-group";
    if (targetUser !== botId) {
      if (botRole === "member") return "insufficient-role";
      const targetRole = await memberRole(targetGroup, targetUser);
      if (!active() || !targetRole) return "rejected";
    }
    return write(targetGroup, targetUser, card);
  };
}
