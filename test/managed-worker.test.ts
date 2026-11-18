import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnManagedWorker } from "../lib/managed-worker.ts";

const revision = "a".repeat(40);
const workerModule = fileURLToPath(new URL("../lib/managed-worker.ts", import.meta.url));

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
    env: { ...process.env, LOTUS_WORKER_FIXTURE: "kept", LOTUS_MANAGED_TOKEN: "override" },
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

test("宿主不发就绪消息会超时，并收到停止信号", () => fixture(`
  import { writeFileSync } from "node:fs";
  process.on("SIGTERM", () => { writeFileSync("stopped", "yes"); process.exit(0); });
  setInterval(() => {}, 1000);
`, async (root) => {
  const worker = spawnManagedWorker(root);
  await expect(worker.ready).rejects.toThrow("就绪超时");
  expect(await worker.exited).toBe(0);
  expect(await readFile(join(root, "stopped"), "utf8")).toBe("yes");
}), 15_000);
