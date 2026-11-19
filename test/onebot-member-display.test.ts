import { expect, test } from "bun:test";
import { OneBotCalls } from "../lib/adapters/onebot-calls.ts";
import { OneBotMemberDisplay, type MemberRosterEntry } from "../lib/adapters/onebot-member-display.ts";

test("OneBot 名单校验群与成员身份，只保留展示字段", async () => {
  const calls = new OneBotCalls();
  const member = { group_id: 77, user_id: 42, nickname: " 昵称 ", card: " 带\n换行 ", role: "owner" };
  const fetch = (data: unknown, fresh = false) => calls.listMemberDisplay((frame) => {
    expect(frame).toMatchObject({
      action: "get_group_member_list", params: { group_id: 77, ...(fresh ? { no_cache: true } : {}) },
    });
    calls.receive({ echo: frame.echo, status: "ok", retcode: 0, data });
    return true;
  }, 77, fresh);
  expect(await fetch([member, { user_id: 43, card: "群名片", nickname: "x".repeat(257), title: "头衔" }]))
    .toEqual([{ id: 42, nickname: "昵称" }, { id: 43, card: "群名片" }]);
  expect(await fetch([member], true)).toEqual([{ id: 42, nickname: "昵称" }]);
  await expect(fetch([{ user_id: 42, card: "未绑定群号" }], true)).rejects.toThrow("无效的群成员列表");
  for (const invalid of [
    null, [member, member], [{ ...member, group_id: 78 }], [{ ...member, user_id: "-1" }], Array(10_001).fill(member),
  ]) await expect(fetch(invalid)).rejects.toThrow("无效的群成员列表");
});

test("显示缓存按连接和群隔离，合并名称但不存角色", () => {
  const left = new OneBotMemberDisplay(async () => []);
  const right = new OneBotMemberDisplay(async () => []);
  const profile = { card: "群内名片", nickname: "初始昵称", role: "admin" };
  left.remember(77, 42, profile);
  left.remember(77, 42, { nickname: "更新昵称" });
  expect(left.peek(77, 42)).toEqual({ card: "群内名片", nickname: "更新昵称" });
  expect(Object.isFrozen(left.peek(77, 42))).toBe(true);
  expect(right.peek(77, 42)).toBeUndefined();
  expect(left.peek(78, 42)).toBeUndefined();

  left.remember(77, 42, { card: "" });
  left.remember(77, 42, { card: "x".repeat(257) });
  left.remember(77, 42, { card: "带\n换行", nickname: "\x00错误昵称" });
  left.remember(77, -1, { nickname: "无效 QQ" });
  left.remember(0, 42, { nickname: "无效群" });
  expect(left.peek(77, 42)).toEqual({ card: "", nickname: "更新昵称" });
  expect(left.peek(77, -1)).toBeUndefined();
  expect(left.peek(0, 42)).toBeUndefined();
});

test("同群名单请求合并，完整刷新保留期间观察到的字段", async () => {
  const pending = Promise.withResolvers<readonly MemberRosterEntry[]>();
  const calls: number[] = [];
  const cache = new OneBotMemberDisplay(async (groupId) => {
    calls.push(groupId);
    if (calls.length === 1) return pending.promise;
    if (calls.length === 2) throw new Error("模拟查询失败");
    return [{ id: 42, nickname: "重新预热" }];
  });

  cache.remember(77, 42, { card: "过时名片", nickname: "已观察" });
  cache.remember(77, 45, { nickname: "已离开的成员" });
  cache.remember(77, 47, { nickname: "缺席成员" });
  const warm = cache.warm(77);
  expect(cache.warm(77)).toBe(warm);
  await Promise.resolve();
  expect(calls).toEqual([77]);
  cache.remember(77, 42, { nickname: "已观察" });
  cache.remember(77, 43, { card: "" });
  cache.remove(77, 45);
  cache.remove(77, 46);
  cache.remember(77, 48, { card: "新名片" });
  cache.remove(77, 49);
  cache.remember(77, 49, { card: "重新加入" });
  const rosterMember = { id: 44, nickname: "名单昵称", role: "owner" };
  pending.resolve([
    { id: 42, nickname: "旧昵称" }, { id: 43, card: "旧名片", nickname: "名单昵称" }, rosterMember,
    { id: 45, nickname: "已离开" }, { id: 46, nickname: "从未缓存但已离开" },
    { id: 49, nickname: "离开前昵称" },
  ]);
  await warm;
  expect(cache.peek(77, 42)).toEqual({ nickname: "已观察" });
  expect(cache.peek(77, 43)).toEqual({ card: "", nickname: "名单昵称" });
  expect(cache.peek(77, 44)).toEqual({ nickname: "名单昵称" });
  expect(cache.peek(77, 45)).toBeUndefined();
  expect(cache.peek(77, 46)).toBeUndefined();
  expect(cache.peek(77, 47)).toBeUndefined();
  expect(cache.peek(77, 48)).toEqual({ card: "新名片" });
  expect(cache.peek(77, 49)).toEqual({ card: "重新加入" });

  await cache.warm(77);
  expect(cache.peek(77, 42)).toEqual({ nickname: "已观察" });
  await cache.warm(77);
  expect(calls).toEqual([77, 77, 77]);
  expect(cache.peek(77, 42)).toEqual({ nickname: "重新预热" });
  expect(cache.peek(77, 44)).toBeUndefined();
});

test("整群清除及连接关闭令旧请求失效", async () => {
  const requests = Array.from({ length: 3 }, () => Promise.withResolvers<readonly MemberRosterEntry[]>());
  let loaded = 0;
  const cache = new OneBotMemberDisplay(() => requests[loaded++]!.promise);
  const old = cache.warm(77);
  await Promise.resolve();
  cache.forget(77);
  const newer = cache.warm(77);
  expect(newer).not.toBe(old);
  await Promise.resolve();
  requests[1]!.resolve([{ id: 42, card: "新一代" }]);
  await newer;
  requests[0]!.resolve([{ id: 42, card: "旧一代" }, { id: 43, card: "陈旧成员" }]);
  await old;
  expect(cache.peek(77, 42)).toEqual({ card: "新一代" });
  expect(cache.peek(77, 43)).toBeUndefined();

  const third = cache.warm(77);
  await Promise.resolve();
  const deferred = cache.warm(78);
  cache.close();
  expect(cache.closed).toBe(true);
  requests[2]!.resolve([{ id: 42, card: "关闭后到达" }]);
  await Promise.all([third, deferred, cache.warm(77)]);
  cache.remember(77, 42, { card: "关闭后观察" });
  expect(loaded).toBe(3);
  expect(cache.peek(77, 42)).toBeUndefined();
});

test("缓存按最近读取保留群，并限制单连接成员总数", () => {
  const groups = new OneBotMemberDisplay(async () => []);
  groups.remember(1, 42, { card: "近期查看" });
  groups.remember(2, 42, { card: "最旧" });
  expect(groups.peek(1, 42)).toEqual({ card: "近期查看" });
  for (let group = 3; group <= 129; group++) groups.remember(group, 42, { card: "新群" });
  expect(groups.peek(1, 42)).toEqual({ card: "近期查看" });
  expect(groups.peek(2, 42)).toBeUndefined();

  const members = new OneBotMemberDisplay(async () => []);
  for (let id = 1; id <= 10_000; id++) members.remember(1, id, { card: "旧群成员" });
  for (let id = 1; id <= 10_001; id++) members.remember(2, id, { card: "新群成员" });
  expect(members.peek(1, 1)).toBeUndefined();
  expect(members.peek(1, 2)).toEqual({ card: "旧群成员" });
  expect(members.peek(2, 10_001)).toEqual({ card: "新群成员" });
});

test("高并发与大量变动仍有界，过期名单不会恢复已移除成员", async () => {
  const pending = Promise.withResolvers<readonly MemberRosterEntry[]>();
  const calls: number[] = [];
  const cache = new OneBotMemberDisplay((groupId) => {
    calls.push(groupId);
    return pending.promise;
  });
  const warmups = Array.from({ length: 16 }, (_, index) => cache.warm(index + 1));
  await cache.warm(17);
  expect(calls).toHaveLength(16);
  expect(calls).not.toContain(17);

  for (let id = 1; id <= 1_025; id++) cache.remove(1, id);
  cache.remember(1, 2, { nickname: "新观察" });
  pending.resolve([{ id: 1, nickname: "已离开" }, { id: 2, nickname: "旧资料" }]);
  await Promise.all(warmups);
  expect(cache.peek(1, 1)).toBeUndefined();
  expect(cache.peek(1, 2)).toEqual({ nickname: "新观察" });
  expect(cache.peek(2, 1)).toEqual({ nickname: "已离开" });
  await cache.warm(17);
  expect(calls).toContain(17);
});
