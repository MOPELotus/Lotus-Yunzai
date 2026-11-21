import { expect, test } from "bun:test";
import { createDispatchPower, readLegacyDispatchPause } from "../lib/dispatch-power.ts";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedDispatchPause } from "../lib/managed-dispatch-pause.ts";
import type { MessageEvent, MessageReply } from "../lib/messages.ts";

function fixture(persist?: (pausedAt?: number) => void) {
  let timestamp = 0;
  const power = createDispatchPower(() => timestamp, undefined, persist);
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

test("状态保存失败保留原派发状态，成功回执在保存之后", async () => {
  const values: (number | undefined)[] = [];
  let unavailable = false;
  const { power, send, advance, replies } = fixture((value) => {
    if (unavailable) throw new Error("fixture");
    values.push(value);
  });
  advance(1000);
  unavailable = true;
  await send("#关机");
  expect(power.paused).toBe(false);
  expect(power.activeSignal.aborted).toBe(false);
  expect(replies).toEqual(["无法保存软关机状态，当前状态保持原样。"]);

  unavailable = false;
  await send("#关机", { reply: (reply) => {
    expect(values).toEqual([1000]);
    expect(reply).toBe("关机成功，本次运行时长1秒");
    return true;
  } });
  unavailable = true;
  await send("#开机");
  expect(power.pausedAt).toBe(1000);
  expect(power.activeSignal.aborted).toBe(true);
  unavailable = false;
  await send("#开机");
  expect(power.paused).toBe(false);
  expect(values).toEqual([1000, undefined]);
});

test("同一后台登记恢复软关机原时间，新的登记不使用历史状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-dispatch-power-"));
  const path = join(directory, "pause");
  try {
    const attempt = crypto.randomUUID();
    const previous = managedDispatchPause(path, attempt);
    const pausedAt = 1_795_230_000_000;
    expect(previous.load()).toBeUndefined();
    previous.save(pausedAt);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(managedDispatchPause(path, attempt).load()).toBe(pausedAt);
    expect(managedDispatchPause(path, crypto.randomUUID()).load()).toBeUndefined();
    previous.save();
    expect(managedDispatchPause(path, attempt).load()).toBeNull();
    expect(managedDispatchPause(path, crypto.randomUUID()).load()).toBeUndefined();

    await writeFile(path, JSON.stringify({ attempt, pausedAt: "invalid" }));
    expect(() => previous.load()).toThrow("无法核实后台软关机状态");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
