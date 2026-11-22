import { groupOperatorAuthority, type GroupModerationResult, type LiveGroupMember } from "./group-moderation.ts";
import type { MessageEvent } from "../messages.ts";

export interface GroupSettingsScope {
  readonly bot: number;
  readonly actor: number;
  readonly group?: number;
  readonly signal: AbortSignal;
  readonly isMaster: () => boolean;
  readonly groupAllowed: (groupId: number) => boolean;
  readonly role: (groupId: number, userId: number, signal: AbortSignal) => Promise<LiveGroupMember["role"] | undefined>;
}

export function bindGroupSettingsAccess({ bot, actor, group, signal, isMaster, groupAllowed, role }: GroupSettingsScope) {
  return async (requestedGroup: number | undefined, request = signal) => {
    if (actor === bot || (group !== undefined && requestedGroup !== undefined)) return;
    const groupId = group ?? requestedGroup;
    if (groupId === undefined || !Number.isSafeInteger(groupId) || groupId <= 0) return;
    const combined = request === signal ? signal : AbortSignal.any([signal, request]);
    const active = () => !combined.aborted && groupAllowed(groupId) && (group !== undefined || isMaster());
    if (!active()) return;

    if (group === undefined) {
      const botRole = await role(groupId, bot, combined).catch(() => undefined);
      if (botRole !== "admin" && botRole !== "owner") return;
    } else if (!await groupOperatorAuthority(id => role(groupId, id, combined), bot, actor, isMaster, active)) {
      return;
    }
    if (active()) return { groupId, signal: combined, active };
  };
}

export function bindGroupName(scope: GroupSettingsScope & {
  readonly write: (groupId: number, name: string, signal: AbortSignal) => Promise<GroupModerationResult>;
}): NonNullable<MessageEvent["setGroupName"]> {
  const authorize = bindGroupSettingsAccess(scope);
  return async (name, requestedGroup) => {
    if (scope.actor === scope.bot || typeof name !== "string" || !name.trim() || name.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(name) || (scope.group !== undefined && requestedGroup !== undefined)) return "rejected";
    const groupId = scope.group ?? requestedGroup;
    if (groupId === undefined || !Number.isSafeInteger(groupId) || groupId <= 0) return "rejected";
    const access = await authorize(requestedGroup);
    if (!access?.active()) return "unavailable";
    return scope.write(access.groupId, name, access.signal).catch(() => "unknown");
  };
}
