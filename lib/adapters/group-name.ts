import { groupOperatorAuthority, type GroupModerationResult, type LiveGroupMember } from "./group-moderation.ts";
import type { MessageEvent } from "../messages.ts";

export function bindGroupName({ bot, actor, group, signal, isMaster, groupAllowed, role, write }: {
  readonly bot: number;
  readonly actor: number;
  readonly group?: number;
  readonly signal: AbortSignal;
  readonly isMaster: () => boolean;
  readonly groupAllowed: (groupId: number) => boolean;
  readonly role: (groupId: number, userId: number, signal: AbortSignal) => Promise<LiveGroupMember["role"] | undefined>;
  readonly write: (groupId: number, name: string, signal: AbortSignal) => Promise<GroupModerationResult>;
}): NonNullable<MessageEvent["setGroupName"]> {
  return async (name, requestedGroup) => {
    if (actor === bot || typeof name !== "string" || !name.trim() || name.length > 512 || /[\u0000-\u001f\u007f]/u.test(name) ||
        (group !== undefined && requestedGroup !== undefined)) return "rejected";
    const groupId = group ?? requestedGroup;
    if (groupId === undefined || !Number.isSafeInteger(groupId) || groupId <= 0) return "rejected";
    const active = () => !signal.aborted && groupAllowed(groupId) && (group !== undefined || isMaster());
    if (!active()) return "unavailable";

    if (group === undefined) {
      const botRole = await role(groupId, bot, signal).catch(() => undefined);
      if (botRole !== "admin" && botRole !== "owner") return "unavailable";
    } else if (!await groupOperatorAuthority(id => role(groupId, id, signal), bot, actor, isMaster, active)) {
      return "unavailable";
    }
    if (!active()) return "unavailable";
    return write(groupId, name, signal).catch(() => "unknown");
  };
}
