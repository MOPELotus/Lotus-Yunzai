import type { GroupNotice, GroupRequest, MessageEvent, MessageReply } from "../messages.ts";

export type GroupModerationResult = "confirmed" | "rejected" | "unknown";
type GroupMemberModerationResult = GroupModerationResult | "protected" | "unavailable";
export type GroupMuteAction = (userId: number, seconds: number) => Promise<GroupMemberModerationResult>;
export type GroupWholeMuteAction = (enabled: boolean) => Promise<GroupModerationResult | "unavailable">;
export type GroupKickAction = (userId: number, block: boolean) => Promise<GroupMemberModerationResult>;
export type GroupManageBlacklistAction = () => Promise<boolean>;
export type GroupSpecialTitleAction = (
  userId: number, title: string, verify?: () => Promise<boolean>,
) => Promise<GroupMemberModerationResult>;
export type GroupSetAdminAction = (userId: number, enabled: boolean) => Promise<GroupMemberModerationResult>;

export interface MutedGroupMember {
  readonly userId: number;
  readonly name?: string;
  readonly role?: Role;
  readonly until: number;
}

export interface GroupActionPolicy {
  readonly canModerateGroups?: () => boolean;
  readonly isProtectedMaster?: (bot: number, user: number) => boolean;
  readonly onMemberMute?: (notice: MemberMuteNotice) => void;
}

export interface MemberMuteNotice {
  readonly self_id: number;
  readonly group_id: number;
  readonly user_id: number;
  readonly operator_id: number;
  readonly time: number;
  readonly duration: number;
  readonly signal: AbortSignal;
  canModerate(signal: AbortSignal): Promise<boolean>;
  unmute(signal: AbortSignal): Promise<GroupModerationResult>;
  reply(reply: MessageReply): Promise<boolean>;
}

export function isMemberMuteDuration(duration: unknown): duration is number {
  return typeof duration === "number" && Number.isInteger(duration) && duration >= 0 && duration <= 2_147_483_647;
}

type Role = "member" | "admin" | "owner";

export function bindMessageGroupActions({ bot, actor, signal, accepting, isMaster, isProtected, role, mute, wholeMute, kick, title, setAdmin }: {
  readonly bot: number;
  readonly actor: number;
  readonly signal: AbortSignal;
  readonly accepting?: () => boolean;
  readonly isMaster: () => boolean;
  readonly isProtected: (userId: number) => boolean;
  readonly role: (userId: number) => Promise<Role | undefined>;
  readonly mute: (userId: number, seconds: number) => Promise<GroupModerationResult>;
  readonly wholeMute: (enabled: boolean) => Promise<GroupModerationResult>;
  readonly kick: (userId: number, block: boolean) => Promise<GroupModerationResult>;
  readonly title: (userId: number, text: string) => Promise<GroupModerationResult>;
  readonly setAdmin: (userId: number, enabled: boolean) => Promise<GroupModerationResult>;
}): {
  groupMute: GroupMuteAction; groupWholeMute: GroupWholeMuteAction; groupKick: GroupKickAction;
  groupManageBlacklist: GroupManageBlacklistAction; groupManageWhitelistAutoUnmute: GroupManageBlacklistAction;
  groupSetSpecialTitle: GroupSpecialTitleAction;
  groupSetAdmin: GroupSetAdminAction;
} {
  const active = () => !signal.aborted && accepting?.() !== false;
  async function authorize() {
    const [actorRole, botRole] = await Promise.all([role(actor), role(bot)]).catch(() => []);
    if (!active() || !actorRole || !botRole) return "unavailable" as const;
    const master = isMaster();
    if ((!master && actorRole === "member") || botRole === "member") return "unavailable" as const;
    return { master, botRole };
  }

  async function apply(write: () => Promise<GroupModerationResult>): Promise<GroupModerationResult | "unavailable"> {
    if (!active()) return "unavailable";
    try {
      return await write();
    } catch {
      return "unknown";
    }
  }

  async function protectedTarget(userId: number, protectMasters: boolean) {
    if (!Number.isSafeInteger(userId) || userId <= 0) return "rejected" as const;
    const authority = await authorize();
    if (typeof authority === "string") return authority;
    const target = await role(userId).catch(() => undefined);
    if (!active() || !target) return "unavailable" as const;
    if (userId === bot || target === "owner" || (protectMasters && isProtected(userId)) ||
        (target === "admin" && (authority.botRole !== "owner" || !authority.master))) return "protected" as const;
  }

  async function canManage(param: "list" | "automatic") {
    if (!active()) return false;
    const authority = await authorize();
    return typeof authority !== "string" && (param === "list" || authority.master) && active();
  }

  async function groupOwnerTarget(userId: number, needsMaster: boolean) {
    if (!active() || (needsMaster && !isMaster())) return "unavailable" as const;
    if (userId === bot) return "protected" as const;
    const [actorRole, botRole, otherRole] = await Promise.all([role(actor), role(bot), userId === actor ? undefined : role(userId)])
      .catch(() => []);
    const targetRole = userId === actor ? actorRole : otherRole;
    if (!active() || !actorRole || !targetRole || botRole !== "owner" || (needsMaster && !isMaster())) return "unavailable" as const;
    return targetRole === "owner" ? "protected" as const : targetRole;
  }

  return {
    async groupMute(userId, seconds) {
      if (!active()) return "unavailable";
      if (!isMemberMuteDuration(seconds)) return "rejected";
      return await protectedTarget(userId, seconds > 0) ?? apply(() => mute(userId, seconds));
    },
    async groupWholeMute(enabled) {
      if (!active()) return "unavailable";
      if (typeof enabled !== "boolean") return "rejected";
      const authority = await authorize();
      if (typeof authority === "string") return authority;
      return apply(() => wholeMute(enabled));
    },
    async groupKick(userId, block) {
      if (!active()) return "unavailable";
      if (typeof block !== "boolean") return "rejected";
      return await protectedTarget(userId, true) ?? apply(() => kick(userId, block));
    },
    groupManageBlacklist: () => canManage("list"),
    groupManageWhitelistAutoUnmute: () => canManage("automatic"),
    async groupSetSpecialTitle(userId, text, verify) {
      if (!Number.isSafeInteger(userId) || userId <= 0 || typeof text !== "string") return "rejected";
      const target = await groupOwnerTarget(userId, userId !== actor);
      if (target === "unavailable" || target === "protected") return target;
      if (verify) {
        const permitted = await verify().catch(() => undefined);
        if (permitted === undefined) return "unavailable";
        if (!permitted) return "protected";
      }
      if (userId !== actor && !isMaster()) return "unavailable";
      return apply(() => title(userId, text));
    },
    async groupSetAdmin(userId, enabled) {
      if (!Number.isSafeInteger(userId) || userId <= 0 || typeof enabled !== "boolean") return "rejected";
      const target = await groupOwnerTarget(userId, true);
      if (target === "unavailable" || target === "protected") return target;
      if (!isMaster() || !active()) return "unavailable";
      if ((target === "admin") === enabled) return "confirmed";
      return apply(() => setAdmin(userId, enabled));
    },
  };
}

interface GroupModerationSession {
  readonly signal: AbortSignal;
  readonly act?: (signal: AbortSignal, reason?: string) => Promise<GroupModerationResult>;
  readonly canModerate?: (signal: AbortSignal) => Promise<boolean>;
  readonly memberMessage?: {
    canAct(signal: AbortSignal): Promise<boolean>;
    botCanAct(signal: AbortSignal): Promise<boolean>;
    mute(seconds: number, signal: AbortSignal): Promise<GroupModerationResult>;
    recall(signal: AbortSignal): Promise<GroupModerationResult>;
  };
}

type GroupModerationEvent = GroupNotice | GroupRequest | MessageEvent;
const sessions = new WeakMap<GroupModerationEvent, GroupModerationSession>();

export function bindGroupModeration(event: GroupModerationEvent, session: GroupModerationSession): void {
  if (!session.signal.aborted) sessions.set(event, session);
}

export function groupModerationSession(event: GroupModerationEvent) {
  const session = sessions.get(event);
  return session?.signal.aborted === false ? session : undefined;
}

export async function canModerateGroupSubject(
  role: (userId: number) => Promise<Role | undefined>, bot: number, subject?: number, permitAdmin = true,
) {
  if (bot === subject) return false;
  const [botRole, subjectRole] = await Promise.all([role(bot), subject === undefined ? undefined : role(subject)]);
  return (botRole === "owner" || botRole === "admin") &&
    (subject === undefined || subjectRole === "member" || (permitAdmin && botRole === "owner" && subjectRole === "admin"));
}
