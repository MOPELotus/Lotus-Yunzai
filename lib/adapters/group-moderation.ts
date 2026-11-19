import type { GroupNotice, GroupRequest } from "../messages.ts";

export type GroupModerationResult = "confirmed" | "rejected" | "unknown";
type GroupMemberModerationResult = GroupModerationResult | "protected" | "unavailable";
export type GroupMuteAction = (userId: number, seconds: number) => Promise<GroupMemberModerationResult>;
export type GroupWholeMuteAction = (enabled: boolean) => Promise<GroupModerationResult | "unavailable">;
export type GroupKickAction = (userId: number, block: boolean) => Promise<GroupMemberModerationResult>;

export interface GroupActionPolicy {
  readonly canModerateGroups?: () => boolean;
  readonly isProtectedMaster?: (bot: number, user: number) => boolean;
}

type Role = "member" | "admin" | "owner";

export function bindMessageGroupActions({ bot, actor, signal, accepting, isMaster, isProtected, role, mute, wholeMute, kick }: {
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
}): { groupMute: GroupMuteAction; groupWholeMute: GroupWholeMuteAction; groupKick: GroupKickAction } {
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

  return {
    async groupMute(userId, seconds) {
      if (!active()) return "unavailable";
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 2_147_483_647) return "rejected";
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
  };
}

interface GroupModerationSession {
  readonly signal: AbortSignal;
  readonly act?: (signal: AbortSignal) => Promise<GroupModerationResult>;
}

const sessions = new WeakMap<GroupNotice | GroupRequest, GroupModerationSession>();

export function bindGroupModeration(event: GroupNotice | GroupRequest, session: GroupModerationSession): void {
  if (!session.signal.aborted) sessions.set(event, session);
}

export function groupModerationSession(event: GroupNotice | GroupRequest) {
  const session = sessions.get(event);
  return session?.signal.aborted === false ? session : undefined;
}
