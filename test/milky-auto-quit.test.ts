import { expect, test } from "bun:test";
import { inspectMilkyAutoQuit } from "../lib/adapters/milky-auto-quit.ts";

const groupId = 2002;
const selfId = 1001;
const otherId = 3003;
const joinedAt = 1_700_000_000;
const group = (member_count: unknown, group_id = groupId) => ({ group: { group_id, member_count } });
const member = (user_id = selfId, extra: Record<string, unknown> = {}) => ({
  group_id: groupId, user_id, role: "member", join_time: joinedAt, ...extra,
});

function fixture(...answers: readonly (Record<string, unknown> | Error | undefined)[]) {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  async function call(action: string, params: Record<string, unknown>) {
    const result = answers[calls.length];
    calls.push({ action, params });
    if (result instanceof Error) throw result;
    return result;
  }
  return { calls, call };
}

test("Milky 自动退群只接受新鲜且相互一致的完整快照", async () => {
  for (const role of ["member", "admin"] as const) {
    const bot = member(selfId, { role });
    const { calls, call } = fixture(group(2), { members: [member(otherId), bot] },
      { member: { ...bot, join_time: joinedAt - 1 } }, group(2));
    expect(await inspectMilkyAutoQuit(call, groupId, selfId, joinedAt, 2)).toEqual({
      memberIds: [otherId, selfId], botRole: role,
    });
    expect(calls).toEqual([
      { action: "get_group_info", params: { group_id: groupId, no_cache: true } },
      { action: "get_group_member_list", params: { group_id: groupId, no_cache: true } },
      { action: "get_group_member_info", params: { group_id: groupId, user_id: selfId, no_cache: true } },
      { action: "get_group_info", params: { group_id: groupId, no_cache: true } },
    ]);
  }
});

test("Milky 自动退群遇到无效输入或不合格群人数时停止查询", async () => {
  const { call, calls } = fixture(group(2));
  for (const [candidateGroup, candidateSelf, eventTime, maximum] of [
    [0, selfId, joinedAt, 2], [groupId, 2 ** 53, joinedAt, 2],
    [groupId, selfId, 0, 2], [groupId, selfId, joinedAt, 0],
  ] as const) expect(await inspectMilkyAutoQuit(call, candidateGroup, candidateSelf, eventTime, maximum)).toBeUndefined();
  expect(calls).toEqual([]);

  for (const count of [group(3), group(0), group("2"), group(2 ** 31), group(2, groupId + 1), undefined, new Error("离线")]) {
    const query = fixture(count);
    expect(await inspectMilkyAutoQuit(query.call, groupId, selfId, joinedAt, 2)).toBeUndefined();
    expect(query.calls.map(({ action }) => action)).toEqual(["get_group_info"]);
  }
});

test("Milky 自动退群拒绝人数不符、重复、异群和缺少机器人的名单", async () => {
  for (const members of [
    [member()], [member(), member()], [member(), member(otherId, { group_id: groupId + 1 })],
    [member(), member(2 ** 53)], [member(otherId), member(otherId + 1)], undefined,
  ]) {
    const { calls, call } = fixture(group(2), { members });
    expect(await inspectMilkyAutoQuit(call, groupId, selfId, joinedAt, 2)).toBeUndefined();
    expect(calls.map(({ action }) => action)).toEqual(["get_group_info", "get_group_member_list"]);
  }
});

test("Milky 自动退群拒绝不明或较晚入群时间、角色变化和末次人数变动", async () => {
  for (const bot of [
    member(selfId, { group_id: groupId + 1 }), member(otherId), member(selfId, { role: "admin" }),
    member(selfId, { role: "owner" }), member(selfId, { join_time: undefined }), member(selfId, { join_time: 0 }),
    member(selfId, { join_time: joinedAt + 1 }),
  ]) {
    const listed = bot.role === "owner" ? member(selfId, { role: "owner" }) : member();
    const { calls, call } = fixture(group(2), { members: [listed, member(otherId)] }, { member: bot });
    expect(await inspectMilkyAutoQuit(call, groupId, selfId, joinedAt, 2)).toBeUndefined();
    expect(calls).toHaveLength(3);
  }
  for (const last of [group(1), group(2, groupId + 1), undefined, new Error("离线")]) {
    const { calls, call } = fixture(group(2), { members: [member(), member(otherId)] }, { member: member() }, last);
    expect(await inspectMilkyAutoQuit(call, groupId, selfId, joinedAt, 2)).toBeUndefined();
    expect(calls).toHaveLength(4);
  }
});
