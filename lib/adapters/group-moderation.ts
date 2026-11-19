import type { GroupNotice, GroupRequest } from "../messages.ts";

export type GroupModerationResult = "confirmed" | "rejected" | "unknown";
export type GroupMuteAction = (userId: number, seconds: number) => Promise<GroupModerationResult | "protected" | "unavailable">;

export interface GroupActionPolicy {
  readonly canModerateGroups?: () => boolean;
  readonly isProtectedMaster?: (bot: number, user: number) => boolean;
}

type Role = "member" | "admin" | "owner";

export function bindMessageGroupMute({ bot, actor, signal, accepting, isMaster, isProtected, role, mute }: {
  readonly bot: number;
  readonly actor: number;
  readonly signal: AbortSignal;
  readonly accepting?: () => boolean;
  readonly isMaster: () => boolean;
  readonly isProtected: (userId: number) => boolean;
  readonly role: (userId: number) => Promise<Role | undefined>;
  readonly mute: (userId: number, seconds: number) => Promise<GroupModerationResult>;
}): GroupMuteAction {
  const active = () => !signal.aborted && accepting?.() !== false;
  return async (userId, seconds) => {
    if (!active()) return "unavailable";
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isInteger(seconds) || seconds < 0 ||
        seconds > 2_147_483_647) return "rejected";
    const [actorRole, botRole, targetRole] = await Promise.all([role(actor), role(bot), role(userId)]).catch(() => []);
    if (!active() || !actorRole) return "unavailable";
    const master = isMaster();
    if (!master && actorRole !== "owner" && actorRole !== "admin") return "rejected";
    if (!botRole || !targetRole) return "unavailable";
    if (botRole !== "owner" && botRole !== "admin") return "rejected";
    if (userId === bot || targetRole === "owner" || (seconds > 0 && isProtected(userId)) ||
        (targetRole === "admin" && (botRole !== "owner" || !master))) return "protected";
    if (!active()) return "unavailable";
    try {
      return await mute(userId, seconds);
    } catch {
      return "unknown";
    }
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
