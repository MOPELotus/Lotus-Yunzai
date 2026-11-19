import { expect, test } from "bun:test";
import type { MilkyConfirmation } from "../lib/adapters/milky-api.ts";
import { createMilkyGroupMute } from "../lib/adapters/milky-group-mute.ts";

const account = 99;
const group = 77;
const epoch = 1_700_000_000;
const memberMute = { allMembers: true, isAdmin: false, isOwner: false };

function event(event_type: string, data: Record<string, unknown>, time = epoch) {
  return { event_type, self_id: account, time, data: { group_id: group, ...data } };
}

function member(role: string, groupId = group, userId = account): MilkyConfirmation {
  return { status: "confirmed", data: { member: { group_id: groupId, user_id: userId, role } } };
}

test("单人禁言只跟踪已绑定机器人，按网关时间过期且不因重放延长", async () => {
  const controller = new AbortController();
  let now = epoch * 1_000 + 2_000;
  let queries = 0;
  const mute = createMilkyGroupMute(account, controller.signal, async () => {
    queries++;
    return { status: "unknown" };
  }, () => now);
  const set = (duration: unknown, time = epoch, user_id = account) => event("group_mute", { user_id, duration }, time);

  mute.observe({ ...set(60), self_id: account + 1 });
  mute.observe(set(60, epoch, 42));
  mute.observe(set(-1));
  mute.observe(set(2 ** 31));
  mute.observe(set("60"));
  expect(await mute.forMessage(group)).toBeUndefined();

  mute.observe(set(10));
  expect(await mute.forMessage(group)).toEqual({ remainingSeconds: 8 });
  expect(await mute.forMessage(group + 1)).toBeUndefined();
  now += 2_000;
  mute.observe(set(10));
  mute.observe(set(0, epoch - 1));
  expect(await mute.forMessage(group)).toEqual({ remainingSeconds: 6 });
  mute.observe(set(0));
  expect(await mute.forMessage(group)).toBeUndefined();

  mute.observe(set(5, epoch + 60));
  expect(await mute.forMessage(group)).toEqual({ remainingSeconds: 5 });
  now += 1_000;
  mute.observe(set(5, epoch + 60));
  expect(await mute.forMessage(group)).toEqual({ remainingSeconds: 4 });
  mute.observe(set(0, epoch + 5));
  expect(await mute.forMessage(group)).toBeUndefined();
  mute.observe(set(5, epoch + 5));
  now += 4_000;
  expect(await mute.forMessage(group)).toEqual({ remainingSeconds: 1 });
  now += 1_000;
  expect(await mute.forMessage(group)).toBeUndefined();
  mute.observe({ ...set(3), time: undefined });
  expect(await mute.forMessage(group)).toEqual({ remainingSeconds: 3 });
  expect(queries).toBe(0);
});

test("全员禁言合并角色查询，仅经核对自身群身份后允许管理员或群主", async () => {
  const requests: unknown[] = [];
  const first = Promise.withResolvers<MilkyConfirmation>();
  let answer = first.promise;
  const mute = createMilkyGroupMute(account, new AbortController().signal, (action, params) => {
    requests.push({ action, params });
    return answer;
  }, () => epoch * 1_000);

  mute.observe(event("group_whole_mute", { is_mute: "true" }));
  expect(await mute.forMessage(group)).toBeUndefined();
  mute.observe(event("group_whole_mute", { is_mute: true }, epoch + 60));
  expect(requests).toEqual([]);
  const pending = [mute.forMessage(group), mute.forMessage(group)];
  expect(requests).toEqual([
    { action: "get_group_member_info", params: { group_id: group, user_id: account, no_cache: true } },
  ]);
  first.resolve(member("admin", group + 1));
  expect(await Promise.all(pending)).toEqual([memberMute, memberMute]);
  answer = Promise.resolve(member("owner", group, account + 1));
  expect(await mute.forMessage(group)).toEqual(memberMute);
  answer = Promise.resolve({ status: "unknown" });
  expect(await mute.forMessage(group)).toEqual(memberMute);
  answer = Promise.resolve(member("member"));
  expect(await mute.forMessage(group)).toEqual(memberMute);

  answer = Promise.resolve(member("admin"));
  mute.observe(event("group_admin_change", { user_id: 42, is_set: true }));
  expect(await mute.forMessage(group)).toEqual(memberMute);
  mute.observe(event("group_admin_change", { user_id: account, is_set: true }));
  expect(await mute.forMessage(group)).toEqual({ ...memberMute, isAdmin: true });
  answer = Promise.resolve(member("owner"));
  mute.observe(event("group_admin_change", { user_id: account, is_set: false }));
  expect(await mute.forMessage(group)).toEqual({ ...memberMute, isOwner: true });

  mute.observe(event("group_mute", { user_id: account, duration: 60 }));
  expect(await mute.forMessage(group)).toEqual({ remainingSeconds: 60 });
  mute.observe(event("group_mute", { user_id: account, duration: 0 }));
  expect(await mute.forMessage(group)).toEqual({ ...memberMute, isOwner: true });
  mute.observe(event("group_whole_mute", { is_mute: false }));
  mute.observe(event("group_whole_mute", { is_mute: true }, epoch - 1));
  expect(await mute.forMessage(group)).toBeUndefined();
});

test("角色回执晚到时按新状态处理，退群、解散和断线清空禁言观察", async () => {
  const controller = new AbortController();
  const stale = Promise.withResolvers<MilkyConfirmation>();
  let answer = stale.promise;
  const mute = createMilkyGroupMute(account, controller.signal, () => answer, () => epoch * 1_000);
  const set = event("group_whole_mute", { is_mute: true });

  mute.observe(set);
  const pending = mute.forMessage(group);
  mute.observe(event("group_admin_change", { user_id: account, is_set: false }));
  answer = Promise.resolve(member("member"));
  stale.resolve(member("admin"));
  expect(await pending).toEqual(memberMute);

  mute.observe(event("group_member_decrease", { user_id: 42 }));
  expect(await mute.forMessage(group)).toEqual(memberMute);
  mute.observe(event("group_member_decrease", { user_id: account }));
  expect(await mute.forMessage(group)).toBeUndefined();
  mute.observe(set);
  mute.observe(event("group_disband", {}));
  expect(await mute.forMessage(group)).toBeUndefined();

  const disconnected = Promise.withResolvers<MilkyConfirmation>();
  answer = disconnected.promise;
  mute.observe(set);
  const late = mute.forMessage(group);
  controller.abort();
  disconnected.resolve(member("owner"));
  expect(await late).toBeUndefined();
  mute.observe(set);
  expect(await mute.forMessage(group)).toBeUndefined();
});
