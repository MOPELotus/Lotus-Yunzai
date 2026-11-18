import type { GroupMembership } from "../messages.ts";

type MilkyCall = (action: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function inspectMilkyAutoQuit(
  call: MilkyCall, groupId: number, selfId: number, joinedAt: number, maxMembers: number,
): Promise<GroupMembership | undefined> {
  if (![groupId, selfId, joinedAt, maxMembers].every(isId)) return;
  const freshGroup = { group_id: groupId, no_cache: true };

  async function memberCount(): Promise<number | undefined> {
    const group = (await call("get_group_info", freshGroup))?.group;
    if (isRecord(group) && group.group_id === groupId && isId(group.member_count) && group.member_count <= 2_147_483_647) {
      return group.member_count;
    }
  }

  try {
    const count = await memberCount();
    if (count === undefined || count > maxMembers) return;
    const members = (await call("get_group_member_list", freshGroup))?.members;
    if (!Array.isArray(members) || members.length !== count) return;

    const memberIds = new Set<number>();
    let listedRole: unknown;
    for (const member of members) {
      if (!isRecord(member) || member.group_id !== groupId || !isId(member.user_id) || memberIds.has(member.user_id)) return;
      memberIds.add(member.user_id);
      if (member.user_id === selfId) listedRole = member.role;
    }
    if (!memberIds.has(selfId)) return;

    const bot = (await call("get_group_member_info", { ...freshGroup, user_id: selfId }))?.member;
    if (!isRecord(bot) || bot.group_id !== groupId || bot.user_id !== selfId || bot.role !== listedRole) return;
    if (bot.role !== "member" && bot.role !== "admin") return;
    if (!isId(bot.join_time) || bot.join_time > joinedAt) return;
    if (await memberCount() !== count) return;
    return { memberIds: [...memberIds], botRole: bot.role };
  } catch {
    return undefined;
  }
}
