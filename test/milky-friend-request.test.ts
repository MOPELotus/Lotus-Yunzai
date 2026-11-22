import { expect, test } from "bun:test";
import { milkyFriendRequest, milkyFriendRequestBatchUsers, milkyFriendRequestLimit } from "../lib/adapters/milky-friend-request.ts";
import type { MessageReply } from "../lib/messages.ts";

const selfId = 1001;
const applicant = 2002;
const time = 1_700_000_000;
const uid = "u_opaque-申请人.42";
const notSent = async () => false;

function envelope(data: Record<string, unknown> = {}) {
  return {
    self_id: selfId, event_type: "friend_request", time,
    data: { initiator_id: applicant, initiator_uid: uid, comment: "你好", via: "QQ号", ...data },
  };
}

test("Milky 好友申请校验账号和不透明 UID，只公开带命名空间的稳定标记", () => {
  const value = envelope();
  const parse = (event: unknown, bot = selfId) => milkyFriendRequest(event, bot, notSent, notSent, []);
  const request = parse(value);
  expect(request).toMatchObject({
    post_type: "request", request_type: "friend", sub_type: "add",
    self_id: selfId, user_id: applicant, comment: "你好", isGroup: false, isPrivate: true, isMaster: false,
  });
  expect(request?.flag).toMatch(/^milky:friend:[a-f0-9]{64}$/u);
  expect(JSON.stringify(request)).not.toContain(uid);
  expect(parse(envelope())?.flag).toBe(request?.flag);
  expect(parse({ ...value, time: time + 1 })?.flag).not.toBe(request?.flag);
  expect(parse({ ...value, self_id: selfId + 1 }, selfId + 1)?.flag).not.toBe(request?.flag);
  expect(parse({ ...value, time: -1 })?.flag).toBe(parse({ ...value, time: undefined })?.flag);
  expect(parse({ ...value, self_id: selfId + 1 })).toBeUndefined();
  expect(parse({ ...value, event_type: "group_join_request" })).toBeUndefined();
  expect(parse(envelope({ initiator_id: selfId }))).toBeUndefined();
  expect(parse(envelope({ initiator_id: 2 ** 53 }))).toBeUndefined();
  for (const initiator_uid of [undefined, "", "a b", "a\n", "x".repeat(4097), "\ud800", 123]) {
    expect(parse(envelope({ initiator_uid }))).toBeUndefined();
  }
});

test("Milky 好友申请审批只提交一次，并保留明确拒绝和未确认结果", async () => {
  const requests: unknown[] = [];
  const pending = Promise.withResolvers<boolean>();
  const request = milkyFriendRequest(envelope({ is_filtered: true }), selfId, (...args) => {
    requests.push(args);
    return pending.promise;
  }, notSent, []);
  if (!request) throw new Error("缺少好友申请。");
  expect(await request.approve(false, "长".repeat(513))).toBe(false);
  expect(requests).toEqual([]);
  const first = request.approve(undefined, "接受时不发送备注");
  expect(await request.approve(false, "拒绝")).toBe(false);
  pending.resolve(false);
  expect(await first).toBe(false);
  expect(await request.approve()).toBe(false);
  expect(requests).toEqual([[request.flag, "accept_friend_request", { initiator_uid: uid, is_filtered: false }]]);

  const failure = new Error("结果未确认");
  const decline = milkyFriendRequest(envelope(), selfId, async (...args) => {
    requests.push(args);
    throw failure;
  }, notSent, []);
  if (!decline) throw new Error("缺少好友申请。");
  await expect(decline.approve(false, "不认识")).rejects.toBe(failure);
  expect(await decline.approve(false)).toBe(false);
  expect(requests[1]).toEqual([
    decline.flag, "reject_friend_request", { initiator_uid: uid, is_filtered: false, reason: "不认识" },
  ]);

  const noRemark = milkyFriendRequest(envelope(), selfId, async (...args) => {
    requests.push(args);
    return true;
  }, notSent, []);
  expect(await noRemark?.approve(false)).toBe(true);
  expect(requests[2]).toEqual([noRemark?.flag, "reject_friend_request", { initiator_uid: uid, is_filtered: false }]);
});

test("Milky 好友申请只回复申请人，给主人通知按确认回执计数", async () => {
  const recipients = [3003, selfId, 4004, 3003, 5005, 0, 2 ** 53];
  const sends: { userId: number; reply: MessageReply }[] = [];
  const confirmed = Promise.withResolvers<boolean>();
  const request = milkyFriendRequest(envelope(), selfId, notSent, async (userId, reply) => {
    sends.push({ userId, reply });
    if (userId === 3003) return confirmed.promise;
    if (userId === 5005) throw new Error("发送未确认");
    return userId === applicant;
  }, recipients);
  if (!request) throw new Error("缺少好友申请。");
  recipients.push(6006);
  expect(await request.reply("收到")).toBe(true);
  expect(await request.notifyMasters("")).toBe(0);
  let done = false;
  const notified = request.notifyMasters("有新申请").then((count) => {
    done = true;
    return count;
  });
  expect(sends).toEqual([
    { userId: applicant, reply: "收到" },
    { userId: 3003, reply: "有新申请" },
    { userId: 4004, reply: "有新申请" },
    { userId: 5005, reply: "有新申请" },
  ]);
  expect(done).toBe(false);
  confirmed.resolve(true);
  expect(await notified).toBe(1);
});

test("好友批量审核取当前账号内两份有效列表，达到协议上限或字段无效时拒绝批量选择", () => {
  const pending = { initiator_id: applicant, initiator_uid: uid, target_user_id: selfId,
    is_filtered: false, time, state: "pending" };
  const none = { requests: [] };
  const batch = (requests: readonly unknown[], risk: unknown = none) => milkyFriendRequestBatchUsers(selfId, { requests }, risk);
  expect(batch([pending, { ...pending, target_user_id: selfId + 1 }, { ...pending, state: "rejected", initiator_id: 3003 }],
    { requests: [{ ...pending, is_filtered: true, initiator_id: 4004 }] })).toEqual([applicant, 4004]);
  expect(milkyFriendRequestBatchUsers(selfId, { requests: [pending] }, undefined)).toBeUndefined();
  expect(batch([pending], null)).toBeUndefined();
  expect(batch(Array.from({ length: milkyFriendRequestLimit }, () => pending))).toBeUndefined();
  expect(batch([pending, { ...pending, state: "unknown" }])).toBeUndefined();
  expect(batch([pending, { ...pending, initiator_uid: null }])).toBeUndefined();
  expect(batch([pending], { requests: [pending] })).toBeUndefined();
});
