import { expect, test } from "bun:test";

const moduleUrl = new URL("../lib/managed-handoff.ts", import.meta.url).href;
const revision = "a".repeat(40);
const token = "ed244011-e1db-4c5e-86a4-d524fc72292a";

async function worker(source: string, options: {
  held?: boolean;
  disconnected?: boolean;
  token?: string;
  paused?: string;
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
    ${source}
  `], {
    env: { PATH: process.env.PATH, LOTUS_MANAGED_TOKEN: options.token ?? token,
      LOTUS_MANAGED_HELD: options.held ? "1" : "0", LOTUS_MANAGED_PAUSED_AT: options.paused },
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
    handoff.onDisconnect(() => assert.fail("unmanaged hook invoked"))();
  `;
  expect(await worker(source, { disconnected: true, held: true, paused: "20" })).toEqual([]);
  expect(await worker(source, { token: "invalid", held: true, paused: "20" })).toEqual([]);
});
