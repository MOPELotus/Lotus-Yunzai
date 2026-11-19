import { expect, test } from "bun:test";

const moduleUrl = new URL("../lib/managed-handoff.ts", import.meta.url).href;
const revision = "a".repeat(40);
const token = "ed244011-e1db-4c5e-86a4-d524fc72292a";

async function worker(source: string, options: {
  held?: boolean;
  disconnected?: boolean;
  token?: string;
  paused?: string;
  adapterReceipts?: string;
  receive?: (message: Record<string, unknown>, child: Bun.Subprocess) => void;
} = {}) {
  const messages: Record<string, unknown>[] = [];
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import assert from "node:assert/strict";
    import { createManagedHandoff } from ${JSON.stringify(moduleUrl)};
    const handoff = createManagedHandoff();
    assert.equal(process.env.LOTUS_MANAGED_TOKEN, undefined);
    assert.equal(process.env.LOTUS_MANAGED_HELD, undefined);
    assert.equal(process.env.LOTUS_MANAGED_PAUSED_AT, undefined);
    assert.equal(process.env.LOTUS_MANAGED_ADAPTER_RECEIPTS, undefined);
    ${source}
  `], {
    env: { PATH: process.env.PATH, LOTUS_MANAGED_TOKEN: options.token ?? token,
      LOTUS_MANAGED_HELD: options.held ? "1" : "0", LOTUS_MANAGED_PAUSED_AT: options.paused,
      LOTUS_MANAGED_ADAPTER_RECEIPTS: options.adapterReceipts },
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
    ipc: options.disconnected ? undefined : (message: Record<string, unknown>, child) => {
      messages.push(message);
      options.receive?.(message, child);
    },
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`工作进程断言失败（${code}）。\n${stderr}`);
    return messages;
  } finally {
    clearTimeout(deadline);
  }
}

test("候选只凭同 token 激活，发送完整修订并携带软关机状态请求重启", async () => {
  const messages = await worker(`
    assert.equal(handoff.managed, true);
    assert.equal(handoff.pausedAt, 20);
    assert.equal(handoff.accepting, false);
    assert.equal(handoff.restart(20), false);
    assert.equal(handoff.reportPower(20), false);
    const probe = (message) => {
      if (message.type === "fixture-probe") process.send({ type: "fixture-state", accepting: handoff.accepting });
    };
    process.on("message", probe);
    const existing = process.listenerCount("message");
    const signal = new AbortController().signal;
    const waiting = handoff.ready("${revision}", signal);
    assert.equal(handoff.ready("${revision}", signal), waiting);
    await waiting;
    assert.equal(process.listenerCount("message"), existing);
    process.off("message", probe);
    assert.equal(handoff.accepting, true);
    assert.equal(handoff.reportPower(-1), false);
    assert.equal(handoff.reportPower(20), true);
    assert.equal(handoff.reportPower(), true);
    assert.equal(handoff.restart(0), false);
    assert.equal(handoff.restart(20), true);
    assert.equal(handoff.restart(20), false);
  `, {
    held: true, paused: "20",
    receive(message, child) {
      if (message.type === "lotus-ready") {
        child.send({ type: "lotus-activate", token: "wrong" });
        child.send({ type: "fixture-probe" });
      } else if (message.type === "fixture-state") {
        child.send({ type: "lotus-activate", token });
      }
    },
  });
  expect(messages).toEqual([
    { type: "lotus-ready", token, revision }, { type: "fixture-state", accepting: false },
    { type: "lotus-power", token, pausedAt: 20 }, { type: "lotus-power", token },
    { type: "lotus-restart", token, pausedAt: 20 },
  ]);
});

test("已运行受管进程可省略修订号，IPC 监听不妨碍自然退出", async () => {
  const messages = await worker(`
    assert.equal(handoff.managed, true);
    assert.equal(handoff.pausedAt, undefined);
    assert.equal(handoff.accepting, true);
    await handoff.ready(undefined, new AbortController().signal);
    assert.equal(handoff.restart(9007199254740992), false);
    assert.equal(handoff.restart(), true);
  `, { paused: "9007199254740992" });
  expect(messages).toEqual([{ type: "lotus-ready", token }, { type: "lotus-restart", token }]);
});

test("就绪通知携带已加载目录，取消更新释放监听且不阻塞退出", async () => {
  const messages = await worker(`
    await handoff.ready(undefined, new AbortController().signal, ["system", "群 工具", "system", "../fake"]);
    const existing = process.listenerCount("message");
    const request = { quiet: true, target: { type: "terminal" }, directories: [] };
    assert.equal(handoff.update(request, () => assert.fail("cancelled update reported progress")), true);
    assert.equal(process.listenerCount("message"), existing + 1);
    handoff.cancelUpdate();
    handoff.cancelUpdate();
    assert.equal(process.listenerCount("message"), existing);
  `);
  expect(messages[0]).toEqual({ type: "lotus-ready", token, plugins: ["system", "群 工具"] });
  expect(messages[1]).toMatchObject({ type: "lotus-update", token, request: { quiet: true } });
});

test("候选等待期间断连会拒绝启动、关闭派发并通知仍登记的清理回调", async () => {
  const messages = await worker(`
    let notifications = 0;
    const dispose = handoff.onDisconnect(() => { assert.fail("disposed callback invoked"); });
    dispose();
    handoff.onDisconnect(() => { assert.equal(handoff.accepting, false); notifications++; });
    await assert.rejects(handoff.ready("${revision}", new AbortController().signal), /未能完成/);
    assert.equal(notifications, 1);
    assert.equal(handoff.accepting, false);
    assert.equal(handoff.restart(), false);
    assert.equal(process.listenerCount("message"), 0);
    handoff.onDisconnect(() => { notifications++; });
    assert.equal(notifications, 2);
  `, { held: true, receive(message, child) { if (message.type === "lotus-ready") child.disconnect(); } });
  expect(messages).toEqual([{ type: "lotus-ready", token, revision }]);
});

test("活动工作进程的管理连接断开时，清理回调能结束运行", async () => {
  const messages = await worker(`
    const running = setInterval(() => {}, 200);
    const disconnected = Promise.withResolvers();
    handoff.onDisconnect(() => {
      clearInterval(running);
      assert.equal(handoff.accepting, false);
      assert.equal(handoff.restart(), false);
      assert.equal(handoff.reportPower(20), false);
      disconnected.resolve();
    });
    assert.equal(handoff.accepting, true);
    await handoff.ready(undefined, new AbortController().signal);
    await disconnected.promise;
  `, { receive(message, child) { if (message.type === "lotus-ready") child.disconnect(); } });
  expect(messages).toEqual([{ type: "lotus-ready", token }]);
});

test("候选取消后不接受激活，错误修订号不发就绪回执", async () => {
  const aborted = await worker(`
    const controller = new AbortController();
    const cancel = (message) => { if (message.type === "fixture-abort") controller.abort(); };
    process.on("message", cancel);
    await assert.rejects(handoff.ready("${revision}", controller.signal), /未能完成/);
    assert.equal(handoff.accepting, false);
    assert.equal(process.listenerCount("message"), 1);
    process.off("message", cancel);
  `, {
    held: true,
    receive(message, child) {
      if (message.type !== "lotus-ready") return;
      child.send({ type: "fixture-abort" });
      child.send({ type: "lotus-activate", token });
    },
  });
  expect(aborted).toEqual([{ type: "lotus-ready", token, revision }]);

  const invalid = await worker(`
    await assert.rejects(handoff.ready("invalid", new AbortController().signal), /未能完成/);
    assert.equal(handoff.accepting, false);
  `, { held: true });
  expect(invalid).toEqual([]);
});

test("无 IPC 或 token 无效时保留非受管模式", async () => {
  const source = `
    assert.equal(handoff.managed, false);
    assert.equal(handoff.pausedAt, undefined);
    assert.equal(handoff.accepting, true);
    await handoff.ready(undefined, AbortSignal.abort());
    assert.equal(handoff.restart(), false);
    assert.equal(handoff.reportPower(20), false);
    assert.equal(handoff.update({ quiet: false, target: { type: "terminal" }, directories: [] }, () => assert.fail()), false);
    handoff.onDisconnect(() => assert.fail("unmanaged hook invoked"))();
  `;
  expect(await worker(source, { disconnected: true, held: true, paused: "20" })).toEqual([]);
  expect(await worker(source, { token: "invalid", held: true, paused: "20" })).toEqual([]);
});

test("更新进度绑定请求与托管令牌，忙时同步通知，终态释放监听", async () => {
  let messagesSent = 0;
  const messages = await worker(`
    const request = { quiet: false, target: { type: "private", botId: 99, id: 51 }, directories: [] };
    assert.equal(handoff.update(request, () => assert.fail("requested before ready")), false);
    await handoff.ready(undefined, new AbortController().signal);
    const existing = process.listenerCount("message");
    const first = Promise.withResolvers();
    const statuses = [];
    assert.equal(handoff.update(request, (status) => {
      statuses.push(status);
      if (status === "switching") first.resolve();
    }), true);
    assert.equal(handoff.update(request, (status) => statuses.push(status)), true);
    assert.deepEqual(statuses, ["busy"]);
    await first.promise;
    assert.deepEqual(statuses, ["busy", "checking", "building", "switching"]);
    assert.equal(process.listenerCount("message"), existing);
    const second = Promise.withResolvers();
    assert.equal(handoff.update(request, second.resolve), true);
    assert.equal(await second.promise, "current");
    assert.equal(process.listenerCount("message"), existing);
  `, {
    receive(message, child) {
      if (message.type !== "lotus-update") return;
      const reply = { type: "lotus-update-progress", token, requestId: message.requestId };
      if (messagesSent++ > 0) {
        child.send({ ...reply, status: "current" });
        return;
      }
      child.send({ ...reply, token: "wrong", status: "failed" });
      child.send({ ...reply, requestId: crypto.randomUUID(), status: "failed" });
      child.send({ ...reply, status: "foreign" });
      for (const status of ["checking", "building", "switching", "failed", "current"]) child.send({ ...reply, status });
    },
  });
  const updates = messages.filter((message) => message.type === "lotus-update");
  expect(updates).toHaveLength(2);
  expect(updates[0]?.requestId).not.toBe(updates[1]?.requestId);
  expect(updates[0]).toMatchObject({ token, request: { quiet: false, target: { type: "private", botId: 99, id: 51 } } });
});

test("旧托管父进程拒绝 Milky 更新和安装，同时保留 OneBot 请求格式", async () => {
  const messages = await worker(`
    await handoff.ready(undefined, new AbortController().signal);
    const listenerCount = process.listenerCount("message");
    const request = { quiet: false, target: { type: "private", botId: 99, id: 51 }, directories: [] };
    const denied = () => assert.fail("unsupported adapter sent progress");
    assert.equal(handoff.update({ ...request, target: { ...request.target, adapter: "milky" } }, denied), false);
    assert.equal(handoff.update({ ...request, install: "weather", target: { ...request.target, type: "group", adapter: "milky" } }, denied), false);
    assert.equal(process.listenerCount("message"), listenerCount);
    const done = Promise.withResolvers();
    assert.equal(handoff.update(request, done.resolve), true);
    assert.equal(handoff.update({ ...request, target: { ...request.target, adapter: "milky" } }, denied), false);
    assert.equal(await done.promise, "current");
  `, {
    receive(message, child) {
      if (message.type === "lotus-update") child.send({ type: "lotus-update-progress", token, requestId: message.requestId, status: "current" });
    },
  });
  expect(messages).toHaveLength(2);
  expect(messages[1]?.request).toEqual({ quiet: false, target: { type: "private", botId: 99, id: 51 }, directories: [] });
});

test("支持适配器回执的父进程收到独立的 Milky 群聊和私聊线格式", async () => {
  const messages = await worker(`
    await handoff.ready(undefined, new AbortController().signal);
    for (const type of ["group", "private"]) {
      const done = Promise.withResolvers();
      const operation = type === "group" ? { requested: "weather" } : { install: "weather" };
      const request = { ...operation, quiet: false, target: { type, adapter: "milky", botId: 99, id: 51 }, directories: [] };
      assert.equal(handoff.update(request, done.resolve), true);
      assert.equal(await done.promise, "unavailable");
    }
  `, {
    adapterReceipts: "1",
    receive(message, child) {
      if (message.type === "lotus-update") child.send({ type: "lotus-update-progress", token, requestId: message.requestId, status: "unavailable" });
    },
  });
  expect(messages.slice(1).map(({ request }) => request)).toEqual([
    { quiet: false, requested: "weather", target: { type: "milky-group", botId: 99, id: 51 }, directories: [] },
    { quiet: false, install: "weather", target: { type: "milky-private", botId: 99, id: 51 }, directories: [] },
  ]);
});
