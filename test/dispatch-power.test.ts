import { expect, test } from "bun:test";
import { createDispatchPower, readLegacyDispatchPause } from "../lib/dispatch-power.ts";
import type { MessageEvent, MessageReply } from "../lib/messages.ts";

function fixture() {
  let timestamp = 0;
  const power = createDispatchPower(() => timestamp);
  const replies: MessageReply[] = [];
  return {
    power, replies,
    advance(milliseconds: number) { timestamp += milliseconds; },
    send(msg: string, overrides: Partial<MessageEvent> = {}) {
      return power.handle({
        post_type: "message", message_type: "group", isGroup: true, isPrivate: false,
        isMaster: true, boundAccount: true, msg, raw_message: msg, message: msg,
        reply: (message) => { replies.push(message); return true; },
        ...overrides,
      });
    },
  };
}

test("只读取旧软关机时间，在实际接管时才移除未变化的旧记录", async () => {
  const pausedAt = 1_795_230_000_000;
  const snapshot = JSON.stringify({ isStop: true, time: pausedAt });
  let stored: string | null = snapshot;
  let writes = 0;
  const redis = {
    async get(key: string) {
      expect(key).toBe("Yz:restart");
      return stored;
    },
    async eval(_script: string, { keys, arguments: [snapshot] }: { keys: string[]; arguments: string[] }) {
      expect(keys).toEqual(["Yz:restart"]);
      writes++;
      if (stored !== snapshot) return 0;
      stored = null;
      return 1;
    },
  };
  const legacy = await readLegacyDispatchPause(redis);
  expect(legacy?.pausedAt).toBe(pausedAt);
  expect(stored).toBe(snapshot);
  expect(writes).toBe(0);

  const replacement = JSON.stringify({ isStop: true, time: pausedAt + 1 });
  stored = replacement;
  expect(await legacy?.take()).toBe(false);
  expect(stored).toBe(replacement);
  const current = await readLegacyDispatchPause(redis);
  expect(await current?.take()).toBe(true);
  expect(stored).toBeNull();
  expect(await current?.take()).toBe(false);

  for (const invalid of [null, "{broken", '{"isExit":true,"time":10}', '{"isStop":true,"time":"10"}']) {
    stored = invalid;
    expect(await readLegacyDispatchPause(redis)).toBeUndefined();
    expect(stored).toBe(invalid);
  }
  expect(writes).toBe(3);
});

test("开关机只识别完整命令，并要求可信主人和已绑定账号或授权终端", async () => {
  const { power, send, replies } = fixture();
  for (const text of ["关机", "#关机 1", "#开机后", " #关机", "#关机\n"]) {
    await send(text);
  }
  await send("#关机", { isMaster: false, sender: { isMaster: true, role: "owner" } });
  await send("#关机", { boundAccount: false });
  await send("#关机", { boundAccount: undefined });
  await send("#关机", { message_type: "terminal", isMaster: false });
  expect(power.paused).toBe(false);
  expect(replies).toEqual([]);

  await send("#关机", { message_type: "terminal", boundAccount: undefined });
  expect(power.paused).toBe(true);
  expect(replies).toEqual(["关机成功，本次运行时长0秒"]);
});

test("仅正确状态下切换，按最近一次切换计算兼容时长", async () => {
  const { power, send, replies, advance } = fixture();
  await send("#开机");
  advance(93_784_005);
  await send("#关机");
  expect(power.paused).toBe(true);
  advance(10_000);
  await send("#关机");
  await send("#开机", { isMaster: false });
  advance(50_250);
  await send("#开机");
  expect(power.paused).toBe(false);
  advance(2_000);
  await send("#关机");
  expect(power.paused).toBe(true);
  expect(replies).toEqual([
    "关机成功，本次运行时长1天2时3分4秒5",
    "开机成功，距离上次关机1分250",
    "关机成功，本次运行时长2秒",
  ]);
});

test("回复等待期间切换已生效，迟到的回复不覆盖更新的状态", async () => {
  const { power, send, replies } = fixture();
  const pending = Promise.withResolvers<boolean>();
  const shuttingDown = send("#关机", {
    reply: () => {
      expect(power.paused).toBe(true);
      return pending.promise;
    },
  });
  expect(power.paused).toBe(true);
  await send("#关机");
  await send("#开机");
  expect(power.paused).toBe(false);
  pending.resolve(false);
  await shuttingDown;
  expect(power.paused).toBe(false);
  expect(replies).toEqual(["开机成功，距离上次关机0秒"]);
});
