import type { GroupNotice, GroupRequest, MessageEvent, MessageReply } from "../messages.ts";

export type GroupModerationResult = "confirmed" | "rejected" | "unknown";
type GroupMemberModerationResult = GroupModerationResult | "protected" | "unavailable";
export type GroupMuteAction = (userId: number, seconds: number) => Promise<GroupMemberModerationResult>;
export type GroupMuteSelfAction = (seconds: number) => Promise<GroupMemberModerationResult>;
export type GroupWholeMuteAction = (enabled: boolean) => Promise<GroupModerationResult | "unavailable">;
export type GroupKickAction = (userId: number, block: boolean) => Promise<GroupMemberModerationResult>;
export type GroupManageBlacklistAction = () => Promise<boolean>;
export type GroupSpecialTitleAction = (
  userId: number, title: string, verify?: () => Promise<boolean>,
) => Promise<GroupMemberModerationResult>;
export type GroupSetAdminAction = (userId: number, enabled: boolean) => Promise<GroupMemberModerationResult>;
export type GroupSetQuotedEssenceAction = (
  enabled: boolean,
) => Promise<GroupModerationResult | "unavailable" | "invalid-quote">;
export interface TimedGroupMuteBinding {
  readonly adapter: "onebot" | "milky";
  readonly botId: number;
  readonly groupId: number;
  readonly issuerId: number;
  readonly enabled: boolean;
}
export type TimedGroupMuteResult = GroupModerationResult | "unavailable";

export interface MutedGroupMember {
  readonly userId: number;
  readonly name?: string;
  readonly role?: Role;
  readonly until: number;
}

export interface GroupActivityMember {
  readonly userId: number;
  readonly name?: string;
  readonly role: Role;
  readonly joinTime: number;
  readonly lastSentTime: number;
}

export type GroupActivityVisibility = "management" | "member";

export function readGroupActivity(members: unknown, scope: {
  readonly group: number; readonly bot: number; readonly actor: number; readonly master: () => boolean;
  readonly count: number;
  readonly visibility?: GroupActivityVisibility;
}): readonly GroupActivityMember[] | undefined {
  if (!Array.isArray(members) || scope.count < 1 || scope.count > 10_000 || members.length !== scope.count) return;
  const roster = new Map<number, GroupActivityMember>();
  for (const row of members as unknown[]) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return;
    const { group_id, user_id, join_time, last_sent_time, role, card, nickname } = row as Record<string, unknown>;
    if (group_id !== scope.group || typeof user_id !== "number" || !Number.isSafeInteger(user_id) ||
        user_id <= 0 || roster.has(user_id) || (role !== "member" && role !== "admin" && role !== "owner") ||
        typeof join_time !== "number" || !Number.isSafeInteger(join_time) || join_time <= 0 || join_time > 8_640_000_000_000 ||
        typeof last_sent_time !== "number" || !Number.isSafeInteger(last_sent_time) || last_sent_time < 0 ||
        last_sent_time > 8_640_000_000_000) return;
    const name = (typeof card === "string" && card.trim()) || (typeof nickname === "string" && nickname.trim()) || undefined;
    roster.set(user_id, { userId: user_id, name, role, joinTime: join_time, lastSentTime: last_sent_time });
  }
  const actor = roster.get(scope.actor);
  if (actor && roster.has(scope.bot) &&
      (scope.visibility === "member" || actor.role !== "member" || scope.master())) return [...roster.values()];
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

async function groupOperatorAuthority(
  role: (id: number) => Promise<Role | undefined>, bot: number, actor: number, isMaster: () => boolean, active: () => boolean,
) {
  const [actorRole, botRole] = await Promise.all([role(actor), role(bot)]).catch(() => []);
  if (!active() || !actorRole || !botRole) return;
  const master = isMaster();
  if ((master || actorRole !== "member") && botRole !== "member") return { master, botRole };
}

export async function runTimedWholeMute(binding: TimedGroupMuteBinding, session: {
  role(userId: number): Promise<Role | undefined>;
  isMaster(): boolean;
  active(): boolean;
  write(enabled: boolean): Promise<GroupModerationResult>;
}): Promise<TimedGroupMuteResult> {
  const { botId, groupId, issuerId, enabled } = binding;
  if (![botId, groupId, issuerId].every(id => Number.isSafeInteger(id) && id > 0) || typeof enabled !== "boolean") return "rejected";
  if (!session.active() || !await groupOperatorAuthority(session.role, botId, issuerId, session.isMaster, session.active) ||
      !session.active()) return "unavailable";
  try { return await session.write(enabled); } catch { return "unknown"; }
}

export function bindMessageGroupActions({ bot, actor, signal, accepting, isMaster, isProtected, role, mute, wholeMute, kick, title, setAdmin,
  essence }: {
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
  readonly essence?: {
    verifyQuote(): Promise<boolean>;
    write(enabled: boolean): Promise<GroupModerationResult>;
  };
}): {
  groupMute: GroupMuteAction; groupWholeMute: GroupWholeMuteAction; groupKick: GroupKickAction;
  groupManageBlacklist: GroupManageBlacklistAction; groupManageWhitelistAutoUnmute: GroupManageBlacklistAction;
  groupSetSpecialTitle: GroupSpecialTitleAction;
  groupSetAdmin: GroupSetAdminAction;
  groupSetQuotedEssence?: GroupSetQuotedEssenceAction;
  groupMuteSelf: GroupMuteSelfAction;
} {
  const active = () => !signal.aborted && accepting?.() !== false;
  async function authorize() {
    return await groupOperatorAuthority(role, bot, actor, isMaster, active) ?? "unavailable" as const;
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
    groupSetQuotedEssence: essence ? async enabled => {
      if (typeof enabled !== "boolean") return "rejected";
      if (!await canManage("list")) return "unavailable";
      if (!await essence.verifyQuote().catch(() => false)) return "invalid-quote";
      if (!await canManage("list")) return "unavailable";
      return apply(() => essence.write(enabled));
    } : undefined,
    async groupMuteSelf(seconds) {
      if (!active()) return "unavailable";
      if (!isMemberMuteDuration(seconds) || seconds === 0) return "rejected";
      if (actor === bot || isProtected(actor)) return "protected";
      const [actorRole, botRole] = await Promise.all([role(actor), role(bot)]).catch(() => []);
      if (!active() || !actorRole || !botRole || botRole === "member") return "unavailable";
      if (isProtected(actor) || actorRole === "owner" || (actorRole === "admin" && botRole !== "owner")) return "protected";
      return apply(() => mute(actor, seconds));
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
