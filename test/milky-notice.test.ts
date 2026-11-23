import { expect, test } from "bun:test";
import { milkyNotice } from "../lib/adapters/milky-notice.ts";
import type { MessageReply } from "../lib/messages.ts";

const selfId = 1001;
const userId = 2002;
const groupId = 3003;
const operatorId = 4004;
const inviterId = 5005;
const time = 1_700_000_000;
const offline = async () => undefined;
const notSent = async () => false;

function envelope(event_type: string, data: Record<string, unknown>) {
  return { self_id: selfId, event_type, time, data };
}

test("Milky 入群区分真实邀请者与操作者，延迟核实群名", async () => {
  const requests: unknown[] = [];
  const replies: unknown[] = [];
  let result: Record<string, unknown> | undefined = { group: { group_id: groupId, group_name: " 测试群 " } };
  const notice = milkyNotice(envelope("group_member_increase", {
    group_id: groupId, user_id: userId, operator_id: operatorId, invitor_id: inviterId,
  }), selfId, async (action, params) => {
    requests.push({ action, params });
    return result;
  }, async (target, reply) => {
    replies.push({ target, reply });
    return true;
  });
  expect(notice).toMatchObject({
    post_type: "notice", notice_type: "group", sub_type: "increase", increase_type: "invite", action_sub_type: "invite",
    time, self_id: selfId, group_id: groupId, user_id: userId, operator_id: operatorId, inviter_id: inviterId,
    isGroup: true, isPrivate: false, isMaster: false,
  });
  expect(requests).toEqual([]);
  if (notice?.notice_type !== "group" || notice.sub_type !== "increase") throw new Error("缺少入群通知。");
  expect(await notice.getGroupName?.()).toBe("测试群");
  expect(requests).toEqual([{ action: "get_group_info", params: { group_id: groupId, no_cache: true } }]);
  result = { group: { group_id: groupId + 1, group_name: "其他群" } };
  expect(await notice.getGroupName?.()).toBeUndefined();
  result = { group: { group_id: groupId, group_name: "换行\n群名" } };
  expect(await notice.getGroupName?.()).toBeUndefined();
  expect(await notice.reply("欢迎")).toBe(true);
  expect(replies).toEqual([{ target: { group_id: groupId }, reply: "欢迎" }]);
});

test("Milky 群成员事件保留可证实的加入、退群和移出原因", () => {
  const increase = (extra: Record<string, unknown>) => milkyNotice(envelope("group_member_increase", {
    group_id: groupId, user_id: userId, ...extra,
  }), selfId, offline, notSent);
  expect(increase({ invitor_id: inviterId })).toMatchObject({
    action_sub_type: "invite", inviter_id: inviterId, operator_id: undefined,
  });
  expect(increase({ operator_id: operatorId })).toMatchObject({
    action_sub_type: "approve", operator_id: operatorId, inviter_id: undefined,
  });
  expect(increase({ operator_id: 0 })).toMatchObject({ action_sub_type: undefined, operator_id: undefined });
  const decrease = (extra: Record<string, unknown>) => milkyNotice(envelope("group_member_decrease", {
    group_id: groupId, user_id: userId, ...extra,
  }), selfId, offline, notSent);
  expect(decrease({ operator_id: operatorId, dismiss: true })).toMatchObject({
    sub_type: "decrease", action_sub_type: "kick", decrease_type: "kick", operator_id: operatorId, dismiss: true,
  });
  expect(decrease({ operator_id: userId })).toMatchObject({
    sub_type: "decrease", decrease_type: "leave", operator_id: userId, dismiss: undefined,
  });
  expect(decrease({})).toMatchObject({ decrease_type: "leave", operator_id: undefined });
  const selfJoined = increase({ user_id: selfId });
  if (selfJoined?.notice_type !== "group" || selfJoined.sub_type !== "increase") throw new Error("缺少机器人入群通知。");
  expect(selfJoined.inspectAutoQuit).toBeUndefined();
  expect(selfJoined.leaveGroup).toBeUndefined();
  expect(milkyNotice(envelope("group_disband", { group_id: groupId, operator_id: operatorId }), selfId, offline, notSent))
    .toBeUndefined();
});

test("Milky 好友戳一戳保留合法两种方向，回复固定原好友", async () => {
  const replies: { target: { group_id: number } | { user_id: number }; reply: MessageReply }[] = [];
  const poke = (extra: Record<string, unknown> = {}) =>
    envelope("friend_nudge", { user_id: userId, is_self_send: false, is_self_receive: true, ...extra });
  const notice = milkyNotice(poke(), selfId, offline, async (target, reply) => {
    replies.push({ target, reply });
    return true;
  });
  expect(notice).toMatchObject({
    post_type: "notice", notice_type: "friend", sub_type: "poke",
    self_id: selfId, user_id: userId, operator_id: userId, target_id: selfId,
    is_self_send: false, is_self_receive: true,
    isGroup: false, isPrivate: true, isMaster: false,
  });
  expect(await notice?.reply("收到")).toBe(true);
  expect(replies).toEqual([{ target: { user_id: userId }, reply: "收到" }]);
  expect(milkyNotice(poke({ is_self_send: true, is_self_receive: false }), selfId, offline, notSent)).toMatchObject({
    notice_type: "friend", sub_type: "poke", self_id: selfId, user_id: userId,
    operator_id: selfId, target_id: userId, is_self_send: true, is_self_receive: false,
  });
  for (const event of [
    poke({ user_id: selfId }), poke({ user_id: 2 ** 53 }), poke({ is_self_send: true }), poke({ is_self_receive: false }),
    poke({ is_self_send: "false" }), { ...poke(), self_id: selfId + 1 }, { ...poke(), self_id: String(selfId) },
    envelope("group_member_increase", { group_id: 0, user_id: userId }),
    envelope("group_member_decrease", { group_id: groupId, user_id: String(userId) }),
  ]) expect(milkyNotice(event, selfId, offline, notSent)).toBeUndefined();
});

test("Milky 通知区分明确未送达与结果未知", async () => {
  const event = envelope("group_member_decrease", { group_id: groupId, user_id: userId });
  expect(await milkyNotice(event, selfId, offline, notSent)?.reply("内容")).toBe(false);
  const failure = new Error("结果未知");
  const uncertain = milkyNotice(event, selfId, async () => { throw failure; }, async () => { throw failure; });
  if (uncertain?.notice_type !== "group" || uncertain.sub_type !== "decrease") throw new Error("缺少退群通知。");
  expect(await uncertain.getGroupName?.()).toBeUndefined();
  await expect(Promise.resolve(uncertain.reply("内容"))).rejects.toBe(failure);
});
