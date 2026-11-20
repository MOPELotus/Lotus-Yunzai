import { expect, test } from "bun:test";
import { createMessageRecallCache, readRecallBody, type FriendRecallScope, type GroupRecallScope } from "../lib/message-recall-notice.ts";

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
  await cache.capture(scope, "重放的原始文字", async () => 600, signal);
  expect(await cache.take(scope, signal)).toBeUndefined();
});

test("不会留存关闭、已中断或过期的原消息，独立缓存实例只消费同一持久原消息一次", async () => {
  const data = new Map<string, { value: string; expires: number }>();
  let now = 1_700_000_000_000;
  const store = {
    async save(key: string, value: string, ttl: number) {
      expect(ttl).toBe(600);
      if ((data.get(key)?.expires ?? 0) <= now) data.set(key, { value, expires: now + ttl * 1_000 });
    },
    async take(key: string) {
      const record = data.get(key);
      if (!record || record.expires <= now || record.value === "null") return null;
      const { value } = record;
      record.value = "null";
      return value;
    },
  };
  const scope: FriendRecallScope = { adapter: "milky", botId: 99, userId: 42, messageId: 15 };
  const active = new AbortController();
  const cache = createMessageRecallCache(() => store, () => now);
  await cache.capture(scope, "关闭时无留存", async () => undefined, active.signal);
  expect(data.size).toBe(0);
  await cache.capture(scope, "原消息可跨进程恢复", async () => 600, active.signal);
  const restarted = createMessageRecallCache(() => store, () => now);
  expect(await restarted.take(scope, active.signal)).toBe("原消息可跨进程恢复");
  expect([...data.values()]).toEqual([{ value: "null", expires: now + 600_000 }]);
  expect(await cache.take(scope, active.signal)).toBeUndefined();
  now += 500_000;
  await restarted.capture(scope, "重放的原始文字", async () => 600, active.signal);
  expect(await cache.take(scope, active.signal)).toBeUndefined();
  expect([...data.values()]).toEqual([{ value: "null", expires: now + 100_000 }]);
  const expiring = { ...scope, messageId: 16 };
  await cache.capture(expiring, "过期内容", async () => 600, active.signal);
  now += 600_001;
  expect(await restarted.take(expiring, active.signal)).toBeUndefined();
  data.clear();
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

test("标准 QQ 表情按原顺序持久化，过期、伪造媒体及超长片段不恢复", async () => {
  const body = readRecallBody([
    { type: "text", text: "第一段" }, { type: "face", id: "14", is_large: true, url: "https://example.test/media" },
    { type: "text", text: "末段" },
  ]);
  const expected = ["第一段", { type: "face", data: { id: 14, is_large: true } }, "末段"] as const;
  expect(body).toEqual(expected);
  expect(readRecallBody([{ type: "image", resource_id: "not-a-face" }])).toBeUndefined();
  expect(readRecallBody([{ type: "face", id: "-2" }])).toBeUndefined();
  expect(readRecallBody([{ type: "face", id: 14, is_large: "true" }])).toBeUndefined();
  expect(readRecallBody(Array.from({ length: 129 }, () => ({ type: "face", id: 0 })))).toBeUndefined();

  let now = 1_700_000_000_000;
  const store = {
    entry: null as string | null,
    async save(_key: string, value: string) { this.entry ??= value; },
    async take() { const found = this.entry; this.entry = "null"; return found; },
  };
  const scope: FriendRecallScope = { adapter: "milky", botId: 99, userId: 42, messageId: 25 };
  const signal = new AbortController().signal;
  const cache = createMessageRecallCache(() => store, () => now);
  await cache.capture(scope, body!, async () => 600, signal);
  expect(store.entry).toBe(JSON.stringify({ parts: expected, expires: now + 600_000 }));
  const restarted = createMessageRecallCache(() => store, () => now);
  expect(await restarted.take(scope, signal)).toEqual(expected);
  store.entry = JSON.stringify({ parts: [{ type: "image" }], expires: now + 600_000 });
  expect(await restarted.take(scope, signal)).toBeUndefined();
  store.entry = JSON.stringify({ parts: expected, expires: now + 600_000 });
  now += 600_001;
  expect(await restarted.take(scope, signal)).toBeUndefined();
});

test("独立原图通过生效留存才读取，消费后原图字节不可重放", async () => {
  const scope: FriendRecallScope = { adapter: "milky", botId: 99, userId: 42, messageId: 53 };
  const signal = new AbortController().signal;
  const file = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=", "base64");
  const reads = Promise.withResolvers<void>();
  const body = [{ type: "image", file }] as const;
  const store = {
    value: null as string | null,
    async has() { return this.value !== null; },
    async save(_key: string, value: string, ttl: number, withImage: boolean) {
      expect(ttl).toBe(60);
      expect(withImage).toBe(true);
      this.value ??= value;
    },
    async take() { const value = this.value; this.value = "null"; return value; },
  };
  let readCount = 0;
  const read = async () => {
    readCount++;
    await reads.promise;
    return body;
  };
  const now = () => 1_700_000_000_000;
  const cache = createMessageRecallCache(() => store, now);
  await cache.capture(scope, read, async () => undefined, signal);
  expect(readCount).toBe(0);
  const first = cache.capture(scope, read, async () => 60, signal);
  expect(cache.capture(scope, read, async () => 60, signal)).toBe(first);
  reads.resolve();
  await first;
  expect(store.value && JSON.parse(store.value)).toEqual({
    parts: [{ type: "image", bytes: file.toString("base64") }], expires: now() + 60_000,
  });
  const restarted = createMessageRecallCache(() => store, now);
  expect(await restarted.take(scope, signal)).toEqual(body);
  expect(store.value).toBe("null");
  await restarted.capture(scope, read, async () => 60, signal);
  expect(readCount).toBe(1);
  expect(await restarted.take(scope, signal)).toBeUndefined();
});
