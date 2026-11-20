import { expect, test } from "bun:test";
import { createMessageRecallCache, type FriendRecallScope, type GroupRecallScope } from "../lib/message-recall-notice.ts";

test("撤回等待原消息留存并只领取一次，同协议当前原好友和消息才匹配", async () => {
  const cache = createMessageRecallCache(() => undefined);
  const scope: FriendRecallScope = { adapter: "onebot", botId: 99, userId: 42, messageId: -15 };
  const signal = new AbortController().signal;
  const enabled = Promise.withResolvers<number>();
  const capture = cache.capture(scope, "原始文字", () => enabled.promise, signal);
  const recall = cache.take(scope, signal);
  expect(await cache.take({ ...scope, userId: 43 }, signal)).toBeUndefined();
  expect(await cache.take({ ...scope, botId: 100 }, signal)).toBeUndefined();
  expect(await cache.take({ ...scope, adapter: "milky" }, signal)).toBeUndefined();
  expect(await cache.take({ ...scope, messageId: -16 }, signal)).toBeUndefined();
  enabled.resolve(600);
  await capture;
  expect(await recall).toBe("原始文字");
  expect(await cache.take(scope, signal)).toBeUndefined();
});

test("不会留存关闭、已中断或过期的原消息，独立缓存实例只消费同一持久原消息一次", async () => {
  const data = new Map<string, string>();
  const store = {
    async save(key: string, value: string, ttl: number) {
      expect(ttl).toBe(600);
      if (!data.has(key)) data.set(key, value);
    },
    async take(key: string) {
      const value = data.get(key) ?? null;
      data.delete(key);
      return value;
    },
  };
  const scope: FriendRecallScope = { adapter: "milky", botId: 99, userId: 42, messageId: 15 };
  const active = new AbortController();
  let now = 1_700_000_000_000;
  const cache = createMessageRecallCache(() => store, () => now);
  await cache.capture(scope, "关闭时无留存", async () => undefined, active.signal);
  expect(data.size).toBe(0);
  await cache.capture(scope, "原消息可跨进程恢复", async () => 600, active.signal);
  const restarted = createMessageRecallCache(() => store, () => now);
  expect(await restarted.take(scope, active.signal)).toBe("原消息可跨进程恢复");
  expect(await cache.take(scope, active.signal)).toBeUndefined();
  await cache.capture(scope, "过期内容", async () => 600, active.signal);
  now += 600_001;
  expect(await restarted.take(scope, active.signal)).toBeUndefined();
  active.abort();
  await cache.capture(scope, "中断后无留存", async () => 600, active.signal);
  expect(data.size).toBe(0);
});

test("同账号的相同原消息编号按群与好友会话分别核对", async () => {
  const cache = createMessageRecallCache(() => undefined);
  const group: GroupRecallScope = { adapter: "onebot", botId: 99, groupId: 77, userId: 42, messageId: 15 };
  const direct: FriendRecallScope = { adapter: group.adapter, botId: group.botId, userId: group.userId, messageId: group.messageId };
  const signal = new AbortController().signal;
  await cache.capture(group, "当前群原文", async () => 600, signal);
  await cache.capture(direct, "好友原文", async () => 600, signal);
  expect(await cache.take({ ...group, groupId: 78 }, signal)).toBeUndefined();
  expect(await cache.take(group, signal)).toBe("当前群原文");
  expect(await cache.take(direct, signal)).toBe("好友原文");
});
