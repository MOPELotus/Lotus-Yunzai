import { expect, test } from "bun:test";
import { milkyGroupRequest } from "../lib/adapters/milky-group-request.ts";
import type { MessageReply } from "../lib/messages.ts";

const selfId = 1001;
const groupId = 2002;
const initiator = 3003;
const applicant = 4004;
const sequence = 76543;

function event(event_type: string, data: Record<string, unknown> = {}) {
  return { self_id: selfId, event_type, data: { group_id: groupId, initiator_id: initiator, ...data } };
}

function fixture(overrides: Partial<Parameters<typeof milkyGroupRequest>[2]> = {}) {
  const decisions: [string, boolean, string | undefined][] = [];
  const groups: [number, MessageReply][] = [];
  const privateMessages: [number, MessageReply][] = [];
  const callbacks: Parameters<typeof milkyGroupRequest>[2] = {
    isMaster: (id) => id === initiator,
    async approve(flag, accept, reason) { decisions.push([flag, accept, reason]); return true; },
    async sendGroup(id, reply) { groups.push([id, reply]); return true; },
    async sendPrivate(id, reply) { privateMessages.push([id, reply]); return true; },
    masterIds: [initiator],
    ...overrides,
  };
  return { callbacks, decisions, groups, privateMessages };
}

test("Milky 群申请准确区分机器人受邀、自行申请和邀请他人入群", async () => {
  const { callbacks, decisions, groups, privateMessages } = fixture();
  const invitation = milkyGroupRequest(event("group_invitation", { invitation_seq: sequence }), selfId, callbacks);
  const join = milkyGroupRequest(event("group_join_request", {
    notification_seq: sequence, is_filtered: true, comment: "希望入群",
  }), selfId, callbacks);
  const third = milkyGroupRequest(event("group_invited_join_request", {
    notification_seq: sequence, target_user_id: applicant, is_filtered: true,
  }), selfId, callbacks);
  if (!invitation || !join || !third) throw new Error("缺少群申请。");
  expect(invitation).toMatchObject({
    request_type: "group", sub_type: "invite", groupRequestScope: "milky",
    isMaster: true, self_id: selfId, group_id: groupId, user_id: initiator, inviter_id: initiator,
  });
  expect(join).toMatchObject({
    groupRequestScope: "milky", sub_type: "add", isMaster: false, user_id: initiator,
    inviter_id: undefined, comment: "希望入群",
  });
  expect(third).toMatchObject({ sub_type: "add", isMaster: false, user_id: applicant, inviter_id: initiator });
  expect(invitation?.decision(true)).toEqual({ action: "accept_group_invitation", params: { group_id: groupId, invitation_seq: sequence } });
  expect(invitation?.decision(false, "不传给协议端")).toEqual({
    action: "reject_group_invitation", params: { group_id: groupId, invitation_seq: sequence },
  });
  expect(join?.decision(false, "拒绝")).toEqual({
    action: "reject_group_request",
    params: { group_id: groupId, notification_seq: sequence, notification_type: "join_request", is_filtered: true, reason: "拒绝" },
  });
  expect(third?.decision(true)).toEqual({
    action: "accept_group_request",
    params: { group_id: groupId, notification_seq: sequence, notification_type: "invited_join_request", is_filtered: false },
  });
  expect(Object.keys(invitation ?? {})).not.toContain("decision");
  expect(JSON.stringify(join)).not.toContain("notification_seq");
  expect(join?.replyToApplicant).toBeUndefined();
  expect(third?.replyToApplicant).toBeUndefined();
  expect(await invitation?.replyToApplicant?.("私聊")).toBe(true);
  expect(await third?.reply("群")).toBe(true);
  expect(privateMessages).toEqual([[initiator, "私聊"]]);
  expect(groups).toEqual([[groupId, "群"]]);
  expect(await invitation?.approve(true, "忽略")).toBe(true);
  expect(await join?.approve(false, "原因")).toBe(true);
  expect(decisions).toEqual([[invitation?.flag, true, undefined], [join?.flag, false, "原因"]]);
  expect(milkyGroupRequest(event("group_invitation", { invitation_seq: sequence }), selfId, {
    ...callbacks, isMaster: () => false,
  })?.isMaster).toBe(false);
});

test("Milky 群申请标记按账号、事件、群、原始序号和过滤类型隔离", () => {
  const { callbacks } = fixture();
  const base = event("group_join_request", { notification_seq: sequence, is_filtered: false });
  const parse = (value: unknown, bot = selfId) => milkyGroupRequest(value, bot, callbacks);
  const original = parse(base)?.flag;
  expect(original).toMatch(/^milky:group:[a-f0-9]{64}$/u);
  expect(parse({ ...base, time: 1_700_000_000 })?.flag).toBe(original);
  for (const signed of [
    event("group_join_request", { notification_seq: sequence, is_filtered: true }),
    event("group_join_request", { notification_seq: sequence + 1, is_filtered: false }),
    event("group_join_request", { group_id: groupId + 1, notification_seq: sequence, is_filtered: false }),
    event("group_invited_join_request", { notification_seq: sequence, target_user_id: applicant }),
    event("group_invitation", { invitation_seq: sequence }),
  ]) {
    expect(parse(signed)?.flag).toMatch(/^milky:group:[a-f0-9]{64}$/u);
    expect(parse(signed)?.flag).not.toBe(original);
  }
  expect(parse({ ...base, self_id: selfId + 1 }, selfId + 1)?.flag).not.toBe(original);
  for (const invalid of [
    { ...base, self_id: selfId + 1 },
    event("friend_request", { notification_seq: sequence, is_filtered: false }),
    event("group_join_request", { notification_seq: sequence, is_filtered: "false" }),
    event("group_join_request", { notification_seq: sequence }),
    event("group_join_request", { notification_seq: 2 ** 53, is_filtered: false }),
    event("group_invitation", { invitation_seq: sequence, initiator_id: selfId }),
    event("group_invitation", { invitation_seq: String(sequence) }),
    event("group_invited_join_request", { notification_seq: sequence, target_user_id: selfId }),
    event("group_invited_join_request", { notification_seq: sequence, target_user_id: applicant, group_id: 0 }),
  ]) expect(parse(invalid)).toBeUndefined();
});

test("Milky 群申请确认未提交后可重试，待定、成功和未确认结果禁止再次发送", async () => {
  const first = Promise.withResolvers<boolean>();
  let attempts = 0;
  const { callbacks } = fixture({
    approve() {
      attempts++;
      return attempts === 1 ? first.promise : Promise.resolve(true);
    },
  });
  const value = event("group_join_request", { notification_seq: sequence, is_filtered: false });
  const request = milkyGroupRequest(value, selfId, callbacks);
  if (!request) throw new Error("缺少群申请。");
  expect(await request.approve(false, "长".repeat(513))).toBe(false);
  expect(attempts).toBe(0);
  const pending = request.approve();
  expect(await request.approve(false)).toBe(false);
  first.resolve(false);
  expect(await pending).toBe(false);
  expect(await request.approve(false)).toBe(true);
  expect(await request.approve()).toBe(false);
  expect(attempts).toBe(2);

  const failure = new Error("动作未确认");
  const unknown = milkyGroupRequest(value, selfId, { ...callbacks, async approve() { throw failure; } });
  if (!unknown) throw new Error("缺少群申请。");
  await expect(unknown.approve()).rejects.toBe(failure);
  expect(await unknown.approve(false)).toBe(false);
});

test("Milky 群申请主人通知只统计已确认收件人", async () => {
  const sent: number[] = [];
  const masterIds = [selfId, initiator, initiator, applicant, 0, 5005, 2 ** 53];
  const { callbacks } = fixture({
    masterIds,
    async sendPrivate(id) {
      sent.push(id);
      if (id === 5005) throw new Error("未确认");
      return id === applicant;
    },
  });
  const request = milkyGroupRequest(event("group_invitation", { invitation_seq: sequence }), selfId, callbacks);
  masterIds.push(6006);
  expect(await request?.notifyMasters("")).toBe(0);
  expect(await request?.notifyMasters("有群邀请")).toBe(1);
  expect(sent).toEqual([initiator, applicant, 5005]);
});
