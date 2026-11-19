import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnManagedWorker } from "../lib/managed-worker.ts";

const revision = "a".repeat(40);
const workerModule = fileURLToPath(new URL("../lib/managed-worker.ts", import.meta.url));
const handoffModule = new URL("../lib/managed-handoff.ts", import.meta.url).href;

function observeTimers() {
  const nativeTimeout = globalThis.setTimeout;
  const scheduled: { delay: number; handle: ReturnType<typeof setTimeout>; fire: () => void }[] = [];
  const mock = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    const handle = nativeTimeout(callback, delay);
    scheduled.push({ delay, handle, fire: () => { clearTimeout(handle); callback(); } });
    return handle;
  }) as typeof setTimeout);
  return {
    scheduled,
    restore() {
      mock.mockRestore();
      for (const { handle } of scheduled) clearTimeout(handle);
    },
  };
}

async function fixture(source: string, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-managed-worker-"));
  try {
    await writeFile(join(root, "app.ts"), source);
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("受管理宿主继承工作目录与环境，按令牌和提交握手后释放，重启请求只转发一次", () => fixture(`
  import assert from "node:assert/strict";
  import { writeFileSync } from "node:fs";
  const token = process.env.LOTUS_MANAGED_TOKEN;
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.equal(process.env.LOTUS_MANAGED_HELD, "1");
  assert.equal(process.env.LOTUS_MANAGED_ADAPTER_RECEIPTS, "1");
  assert.equal(process.env.LOTUS_MANAGED_PAUSED_AT, "123456");
  assert.equal(process.env.LOTUS_WORKER_FIXTURE, "kept");
  writeFileSync("cwd", process.cwd());
  process.on("SIGINT", () => { writeFileSync("stopped", "SIGINT"); process.exit(23); });
  process.on("message", (message) => {
    assert.deepEqual(message, { type: "lotus-activate", token });
    writeFileSync("active", "yes");
    process.send({ type: "lotus-restart", token: "wrong" });
    process.send({ type: "lotus-restart", token, pausedAt: "123456" });
    process.send({ type: "lotus-restart", token, pausedAt: 123456 });
    process.send({ type: "lotus-restart", token });
  });
  process.send({ type: "lotus-ready", token: "wrong", revision: "wrong" });
  process.send({ type: "lotus-ready", token, revision: "${revision}" });
  process.send({ type: "lotus-restart", token });
  setInterval(() => {}, 1000);
`, async (root) => {
  let restarts = 0;
  const restarted = Promise.withResolvers<void>();
  const worker = spawnManagedWorker(root, {
    held: true, expectedRevision: revision, pausedAt: 123456,
    env: { ...process.env, LOTUS_WORKER_FIXTURE: "kept", LOTUS_MANAGED_TOKEN: "override", LOTUS_MANAGED_ADAPTER_RECEIPTS: "0" },
    onRestart(pausedAt) {
      restarts++;
      if (pausedAt === 123456) restarted.resolve();
      else restarted.reject(new Error("暂停状态没有保留。"));
    },
  });
  try {
    expect(() => worker.activate()).toThrow("尚未就绪");
    await worker.ready;
    expect(await readFile(join(root, "cwd"), "utf8")).toBe(root);
    expect(await Bun.file(join(root, "active")).exists()).toBe(false);
    expect(restarts).toBe(0);
    worker.activate();
    worker.activate();
    await restarted.promise;
    expect(await readFile(join(root, "active"), "utf8")).toBe("yes");
    expect(await worker.stop("SIGINT")).toBe(23);
    expect(await worker.exited).toBe(23);
    expect(restarts).toBe(1);
    expect(await readFile(join(root, "stopped"), "utf8")).toBe("SIGINT");
    expect(() => worker.activate()).toThrow("已退出");
  } finally {
    await worker.stop();
  }
}));

test("握手前自然退出保留退出码，拒绝错误提交并强制回收不响应优雅停止的宿主", async () => {
  await fixture(`process.exit(process.env.LOTUS_MANAGED_PAUSED_AT === undefined ? 7 : 1);`, async (root) => {
    const worker = spawnManagedWorker(root, {
      env: { ...process.env, LOTUS_MANAGED_PAUSED_AT: "123456" }, pausedAt: -1,
    });
    await expect(worker.ready).rejects.toThrow("就绪前退出");
    expect(await worker.exited).toBe(7);
  });
  await fixture(`
    import { writeFileSync } from "node:fs";
    process.on("SIGTERM", () => { writeFileSync("stopping", "yes"); });
    process.send({ type: "lotus-ready", token: process.env.LOTUS_MANAGED_TOKEN, revision: "${"b".repeat(40)}" });
    writeFileSync("pid", String(process.pid));
    setInterval(() => {}, 1000);
  `, async (root) => {
    const worker = spawnManagedWorker(root, { expectedRevision: revision });
    await expect(worker.ready).rejects.toThrow("与预期不符");
    expect(await worker.exited).toBe(137);
    expect(await readFile(join(root, "stopping"), "utf8")).toBe("yes");
    const pid = Number(await readFile(join(root, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

test("停止信号发给宿主进程组，等待子任务和宿主退出", () => fixture(`
  import { writeFileSync } from "node:fs";
  const child = Bun.spawn([process.execPath, "-e", [
    'import { writeFileSync } from "node:fs";',
    'process.on("SIGTERM", () => { writeFileSync("child-stopped", "yes"); process.exit(0); });',
    'writeFileSync("child-running", String(process.pid));',
    'setInterval(() => {}, 1000);',
  ].join("\\n")]);
  process.on("SIGTERM", async () => { await child.exited; process.exit(0); });
  while (!await Bun.file("child-running").exists()) await Bun.sleep(5);
  process.send({ type: "lotus-ready", token: process.env.LOTUS_MANAGED_TOKEN });
  setInterval(() => {}, 1000);
`, async (root) => {
  const worker = spawnManagedWorker(root);
  try {
    await worker.ready;
    expect(await worker.stop()).toBe(0);
    expect(await readFile(join(root, "child-stopped"), "utf8")).toBe("yes");
    const pid = Number(await readFile(join(root, "child-running"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await worker.stop();
  }
}));

test("默认继承父进程环境与终端输入输出", () => fixture(`
  process.send({ type: "lotus-ready", token: process.env.LOTUS_MANAGED_TOKEN });
  process.stdout.write(process.env.LOTUS_WORKER_FIXTURE + ":" + await Bun.stdin.text());
  process.stderr.write("worker-stderr");
  process.exit(0);
`, async (root) => {
  const supervisor = Bun.spawn([process.execPath, "-e", `
    import { spawnManagedWorker } from ${JSON.stringify(workerModule)};
    const worker = spawnManagedWorker(process.cwd());
    await worker.ready;
    process.exitCode = await worker.exited;
  `], {
    cwd: root, env: { ...process.env, LOTUS_WORKER_FIXTURE: "inherited" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  supervisor.stdin.write("terminal command");
  supervisor.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(supervisor.stdout).text(), new Response(supervisor.stderr).text(), supervisor.exited,
  ]);
  expect(code).toBe(0);
  expect(stdout).toBe("inherited:terminal command");
  expect(stderr).toBe("worker-stderr");
}));

test.skipIf(process.platform === "win32")("前台终端可输入命令，停止子宿主不向父进程组发信号", () => fixture(`
  import { createInterface } from "node:readline";
  import { writeFileSync } from "node:fs";
  process.on("SIGTERM", () => { writeFileSync("tty-stopped", "yes"); process.exit(0); });
  createInterface({ input: process.stdin }).on("line", (line) => console.log("worker-tty:" + line));
  process.send({ type: "lotus-ready", token: process.env.LOTUS_MANAGED_TOKEN });
`, async (root) => {
  const received = Promise.withResolvers<void>();
  let output = "";
  const supervisor = Bun.spawn([process.execPath, "-e", `
    import { spawnManagedWorker } from ${JSON.stringify(workerModule)};
    if (!process.stdin.isTTY) process.exit(2);
    const worker = spawnManagedWorker(process.cwd());
    process.on("SIGTERM", () => { void worker.stop(); });
    await worker.ready;
    process.exitCode = await worker.exited;
  `], {
    cwd: root,
    terminal: { data(_, bytes) {
      output += new TextDecoder().decode(bytes);
      if (output.includes("worker-tty:hello")) received.resolve();
    } },
  });
  const deadline = setTimeout(() => received.reject(new Error("终端未接收命令。")), 2_000);
  try {
    supervisor.terminal?.write("hello\n");
    await received.promise;
    supervisor.kill("SIGTERM");
    expect(await supervisor.exited).toBe(0);
    expect(await readFile(join(root, "tty-stopped"), "utf8")).toBe("yes");
  } finally {
    clearTimeout(deadline);
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    await supervisor.exited;
    supervisor.terminal?.close();
  }
}));

test("插件更新仅在工作进程确认全部指定目录已加载后就绪", async () => {
  const source = (plugins: string[]) => `
    process.on("SIGTERM", () => process.exit(19));
    process.on("message", (message) => { if (message.type === "lotus-activate") process.exit(0); });
    process.send({ type: "lotus-ready", token: process.env.LOTUS_MANAGED_TOKEN, plugins: ${JSON.stringify(plugins)},
      revision: "${revision}" });
    setTimeout(() => process.exit(20), 2500);
  `;
  const expectedPlugins = ["群插件", "weather-plugin"];
  await fixture(source(["system", "群插件"]), async (root) => {
    const worker = spawnManagedWorker(root, { held: true, expectedRevision: revision, expectedPlugins });
    await expect(worker.ready).rejects.toThrow("未加载预期");
    expect(await worker.exited).toBe(19);
  });
  await fixture(source(["system", "群插件", "weather-plugin"]), async (root) => {
    const worker = spawnManagedWorker(root, { held: true, expectedRevision: revision, expectedPlugins });
    try {
      await worker.ready;
      worker.activate();
      expect(await worker.exited).toBe(0);
    } finally {
      await worker.stop();
    }
  });
});

test("父进程只转发有效的活动宿主更新请求，串行报告进度并丢弃重放", () => fixture(`
  import assert from "node:assert/strict";
  import { writeFileSync } from "node:fs";
  const token = process.env.LOTUS_MANAGED_TOKEN;
  const create = (requested) => ({ type: "lotus-update", token, requestId: crypto.randomUUID(),
    request: { requested, quiet: false, target: { type: "terminal" }, directories: [] } });
  const valid = create("有效");
  const busy = create("繁忙");
  const failure = create("失败");
  const seen = [];
  process.send(create("启动前"));
  process.send({ type: "lotus-ready", token, revision: "${revision}" });
  process.on("message", (message) => {
    if (message.type === "lotus-activate") {
      process.send({ ...valid, token: "wrong" });
      process.send({ ...valid, requestId: "wrong" });
      process.send({ ...valid, request: { ...valid.request, requested: "bad;value" } });
      process.send(valid);
      process.send(valid);
      return;
    }
    assert.equal(message.type, "lotus-update-progress");
    assert.equal(message.token, token);
    if (message.requestId === valid.requestId) {
      seen.push(message.status);
      if (message.status === "checking") process.send(busy);
      if (message.status === "current") { process.send(valid); process.send(failure); }
    } else if (message.requestId === busy.requestId) {
      assert.equal(message.status, "busy");
      seen.push(message.status);
      writeFileSync("busy", "yes");
    } else {
      assert.equal(message.requestId, failure.requestId);
      assert.equal(message.status, "failed");
      assert.deepEqual(seen, ["checking", "busy", "building", "current"]);
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(72), 2500);
`, async (root) => {
  const requested: (string | undefined)[] = [];
  const worker = spawnManagedWorker(root, {
    held: true, expectedRevision: revision,
    async onUpdate(request, report) {
      requested.push(request.requested);
      if (request.requested === "失败") throw new Error("fixture exception");
      report("checking");
      const deadline = performance.now() + 1000;
      while (!await Bun.file(join(root, "busy")).exists() && performance.now() < deadline) await Bun.sleep(5);
      report("building");
      report("current");
      report("failed");
    },
  });
  try {
    await worker.ready;
    worker.activate();
    expect(await worker.exited).toBe(0);
    expect(requested).toEqual(["有效", "失败"]);
  } finally {
    await worker.stop();
  }
}));

test("新托管父进程启用并转发 Milky 聊天请求的协议身份", () => fixture(`
  import assert from "node:assert/strict";
  import { createManagedHandoff } from ${JSON.stringify(handoffModule)};
  const handoff = createManagedHandoff();
  assert.equal(process.env.LOTUS_MANAGED_ADAPTER_RECEIPTS, undefined);
  await handoff.ready("${revision}", new AbortController().signal);
  for (const type of ["group", "private"]) {
    const done = Promise.withResolvers();
    const request = { quiet: false, target: { type, adapter: "milky", botId: 99, id: 51 }, directories: [] };
    if (type === "private") request.install = "weather";
    assert.equal(handoff.update(request, done.resolve), true);
    assert.equal(await done.promise, "current");
  }
  process.exit(0);
`, async (root) => {
  const requests: unknown[] = [];
  const worker = spawnManagedWorker(root, {
    expectedRevision: revision,
    env: { PATH: process.env.PATH, LOTUS_MANAGED_ADAPTER_RECEIPTS: "disabled-in-parent" },
    onUpdate(request, report) {
      requests.push(request);
      report("current");
    },
  });
  const deadline = setTimeout(() => { void worker.stop(); }, 2_000);
  try {
    await worker.ready;
    expect(await worker.exited).toBe(0);
    expect(requests).toEqual([
      { quiet: false, target: { type: "group", adapter: "milky", botId: 99, id: 51 }, directories: [] },
      { quiet: false, install: "weather", target: { type: "private", adapter: "milky", botId: 99, id: 51 }, directories: [] },
    ]);
  } finally {
    clearTimeout(deadline);
    await worker.stop();
  }
}));

test("宿主停止时处理最后一条已认证的暂停状态，省略时间表示已恢复", async () => {
  const source = `
    const token = process.env.LOTUS_MANAGED_TOKEN;
    const snapshot = { type: "lotus-power", token };
    process.on("SIGTERM", () => {
      process.send({ ...snapshot, pausedAt: 200 });
      process.send({ ...snapshot, pausedAt: "300" });
      process.send({ ...snapshot, pausedAt: -300 });
      process.send({ ...snapshot, pausedAt: undefined });
      process.send({ ...snapshot, pausedAt: 300, token: "mismatched" });
      process.send({ ...snapshot, type: "lotus-restart", pausedAt: 300 });
      if (process.env.LOTUS_POWER_TEST_CLEAR === "yes") process.send(snapshot);
      process.send({ ...snapshot, pausedAt: null }, () => process.exit(27));
    });
    process.send({ ...snapshot, pausedAt: 81 });
    process.send({ type: "lotus-ready", token });
    setInterval(() => {}, 1000);
  `;
  for (const clear of [false, true]) {
    await fixture(source, async (root) => {
      let restarts = 0;
      const worker = spawnManagedWorker(root, {
        pausedAt: 72, env: { ...process.env, LOTUS_POWER_TEST_CLEAR: clear ? "yes" : "no" }, onRestart() { restarts++; },
      });
      try {
        expect(worker.pausedAt).toBe(72);
        await worker.ready;
        expect(worker.pausedAt).toBe(72);
        expect(await worker.stop()).toBe(27);
        expect(worker.pausedAt).toBe(clear ? undefined : 200);
        expect(restarts).toBe(0);
      } finally {
        await worker.stop();
      }
    });
  }
});

test("候选就绪但未激活时无法写入暂停状态", () => fixture(`
  const token = process.env.LOTUS_MANAGED_TOKEN;
  process.send({ type: "lotus-ready", token, revision: "${revision}" });
  process.send({ type: "lotus-power", token, pausedAt: 500 }, () => process.exit(0));
`, async (root) => {
  const worker = spawnManagedWorker(root, { held: true, expectedRevision: revision, pausedAt: -1 });
  try {
    await worker.ready;
    expect(await worker.exited).toBe(0);
    expect(worker.pausedAt).toBeUndefined();
  } finally {
    await worker.stop();
  }
}));

test("仅认证且连续的插件加载进度会重设就绪看门狗，零等待恢复默认宽限", () => fixture(`
  const token = process.env.LOTUS_MANAGED_TOKEN;
  const progress = { type: "lotus-plugin-loading", token };
  process.send({ ...progress, index: 1, wait: 77, token: "wrong" });
  process.send({ ...progress, index: 2, wait: 77 });
  process.send({ ...progress, index: "1", wait: 77 });
  for (const wait of [-1, 0.5, "77", 2147473648]) process.send({ ...progress, index: 1, wait });
  process.send({ ...progress, index: 1, wait: 2147473647 });
  process.send({ ...progress, index: 1, wait: 77 });
  process.send({ ...progress, index: 3, wait: 77 });
  process.send({ ...progress, index: 2, wait: 500 });
  process.send({ ...progress, index: 3, wait: 0 });
  process.send({ type: "lotus-ready", token });
  process.send({ ...progress, index: 4, wait: 77 }, () => process.exit(0));
`, async (root) => {
  const timers = observeTimers();
  try {
    const worker = spawnManagedWorker(root);
    try {
      await worker.ready;
      expect(await worker.exited).toBe(0);
      expect(timers.scheduled.map(({ delay }) => delay)).toEqual([10_000, 2_147_483_647, 10_500, 10_000]);
    } finally {
      await worker.stop();
    }
  } finally {
    timers.restore();
  }
}));

test("旧宿主未就绪仍按固定宽限停止，清理期间不接受延长", () => fixture(`
  import { writeFileSync } from "node:fs";
  process.on("SIGTERM", () => {
    writeFileSync("stopped", "yes");
    process.send({ type: "lotus-plugin-loading", token: process.env.LOTUS_MANAGED_TOKEN, index: 1, wait: 77 },
      () => process.exit(0));
  });
  writeFileSync("booting", "yes");
  setInterval(() => {}, 1000);
`, async (root) => {
  const timers = observeTimers();
  try {
    const worker = spawnManagedWorker(root);
    try {
      const deadline = performance.now() + 2_000;
      while (!await Bun.file(join(root, "booting")).exists() && performance.now() < deadline) await Bun.sleep(5);
      expect(await Bun.file(join(root, "booting")).exists()).toBe(true);
      expect(timers.scheduled.map(({ delay }) => delay)).toEqual([10_000]);
      timers.scheduled[0]!.fire();
      await expect(worker.ready).rejects.toThrow("就绪超时");
      expect(await worker.exited).toBe(0);
      expect(await readFile(join(root, "stopped"), "utf8")).toBe("yes");
      expect(timers.scheduled.map(({ delay }) => delay)).toEqual([10_000, 1_000]);
    } finally {
      await worker.stop();
    }
  } finally {
    timers.restore();
  }
}));
