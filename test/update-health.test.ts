import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { pluginProbeTokenEnvironment, pluginStartupGraceMs } from "../lib/plugin-load-progress.ts";
import { verifyUpdateHealth } from "../lib/update-health.ts";
import { copyHost } from "./host-fixture.ts";

const revision = "a".repeat(40);
const failure = /^更新候选运行状态验证失败。$/u;

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-update-health-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectReaped(root: string) {
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  expect(pid).toBeGreaterThan(1);
  expect(() => process.kill(pid, 0)).toThrow();
}

async function scaledProbe(root: string, assertion: string): Promise<number[]> {
  const implementation = new URL("../lib/update-health.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
    import assert from "node:assert/strict";
    import { verifyUpdateHealth } from ${JSON.stringify(implementation)};
    const scheduled = [];
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = (callback, timeout, ...args) => {
      if (timeout >= ${pluginStartupGraceMs}) {
        scheduled.push(timeout);
        timeout = timeout - ${pluginStartupGraceMs} + 500;
      }
      return schedule(callback, timeout, ...args);
    };
    const probe = verifyUpdateHealth(process.cwd(), ${JSON.stringify(revision)});
    ${assertion}
    console.log(JSON.stringify(scheduled));
  `], {
    cwd: root, env: { PATH: process.env.PATH }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    timeout: 5_000, killSignal: "SIGKILL",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`探测夹具失败。\n${stderr}`);
  return JSON.parse(stdout);
}

test("隔离目录启动真实宿主，检查完整提交和状态后等待插件清理", () => fixture(async (root) => {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
      cwd: root, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
    });
    if (result.exitCode !== 0) throw new Error(`Git 夹具操作失败（${args[0]}）。`);
    return result.stdout.toString().trim();
  };
  await copyHost(root);
  await writeFile(join(root, ".env"), "LOTUS_VALKEY_URL=http://127.0.0.1:1\nLOTUS_LISTEN_HOST=bad-hostname.invalid\n");
  await writeFile(join(root, "plugins", "health-fixture.js"), `
    export default class extends plugin {
      async init() {
        await Bun.write("pid", String(process.pid));
        this.addCleanup(async () => { await Bun.write("stopped", "clean"); });
      }
    }
  `);
  git("init", "--quiet", "-b", "main");
  git("add", "app.ts", "lib", "plugins");
  git("commit", "--quiet", "-m", "candidate fixture");
  const actual = git("rev-parse", "HEAD");

  await verifyUpdateHealth(root, actual);
  expect(await readFile(join(root, "stopped"), "utf8")).toBe("clean");
  await expectReaped(root);
}));

test("探测隔离宿主变量和代理，重试临时状态、错误提交和过大的响应", () => fixture(async (root) => {
  await writeFile(join(root, "app.ts"), `
    import assert from "node:assert/strict";
    assert.equal(process.env.LOTUS_HTTP_PORT, "0");
    assert.equal(process.env.LOTUS_LISTEN_HOST, "127.0.0.1");
    assert.equal(process.env.LOTUS_UPDATE_HEALTH_TEST_PRIVATE, undefined);
    assert.equal(process.env.HTTP_PROXY, undefined);
    assert.ok(process.env.LOTUS_HTTP_TOKEN);
    let seen = 0;
    await Bun.write("pid", String(process.pid));
    const server = Bun.serve({ hostname: process.env.LOTUS_LISTEN_HOST, port: Number(process.env.LOTUS_HTTP_PORT), async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/status");
      assert.equal(request.headers.get("Authorization"), "Bearer " + process.env.LOTUS_HTTP_TOKEN);
      seen++;
      if (seen === 1) return Response.json({ status: "starting", revision: "${revision}" });
      if (seen === 2) return Response.json({ status: "ok", revision: "${"b".repeat(40)}" });
      if (seen === 3) return Response.json({ status: "ok", revision: "${revision}", padding: "x".repeat(8000) });
      await Bun.write("hits", String(seen));
      return Response.json({ status: "ok", revision: "${revision}" });
    } });
    console.log("prefix".repeat(50_000));
    process.stdout.write("HTTP 正在监");
    await Bun.sleep(20);
    console.log("听 " + server.url.origin + "/status");
  `);
  const settings = { HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "", LOTUS_UPDATE_HEALTH_TEST_PRIVATE: "fixture" };
  const saved = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, settings);
    await verifyUpdateHealth(root, revision);
    expect(await readFile(join(root, "hits"), "utf8")).toBe("4");
    await expectReaped(root);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}));

test("提前退出不回显候选输出，错误的候选提交不被接受", () => fixture(async (root) => {
  await writeFile(join(root, "app.ts"), `
    await Bun.write("pid", String(process.pid));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      setTimeout(() => process.exit(3), 50);
      return Response.json({ status: "ok", revision: "${"b".repeat(40)}" });
    } });
    console.error("candidate fixture private output");
    console.log("HTTP 正在监听 " + server.url.origin + "/status");
  `);
  await expect(verifyUpdateHealth(root, revision)).rejects.toThrow(failure);
  await expectReaped(root);
  await expect(verifyUpdateHealth(root, "abc")).rejects.toThrow(failure);
}));

test("超时仍等待拒绝 SIGTERM 的候选进程被回收", () => fixture(async (root) => {
  await writeFile(join(root, "app.ts"), `
    process.on("SIGTERM", () => {});
    await Bun.write("pid", String(process.pid));
    setInterval(() => {}, 1000);
  `);
  expect(await scaledProbe(root, `await assert.rejects(probe, { message: ${failure} });`)).toEqual([pluginStartupGraceMs]);
  await expectReaped(root);
}));

test("隔离探测逐入口延长启动预算，HTTP 验证开始后忽略 IPC 进度", () => fixture(async (root) => {
  await writeFile(join(root, "app.ts"), `
    import assert from "node:assert/strict";
    const token = process.env[${JSON.stringify(pluginProbeTokenEnvironment)}];
    assert.ok(token);
    assert.notEqual(token, process.env.LOTUS_HTTP_TOKEN);
    assert.equal(process.env.LOTUS_MANAGED_TOKEN, undefined);
    function report(index, wait, source = token) {
      process.send({ type: "lotus-plugin-loading", token: source, index, wait });
    }
    await Bun.write("pid", String(process.pid));
    report(1, 391, "wrong-token");
    report(2, 392);
    report(1, 500);
    await Bun.sleep(625);
    report(2, 0);
    await Bun.sleep(30);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      assert.equal(request.headers.get("Authorization"), "Bearer " + process.env.LOTUS_HTTP_TOKEN);
      report(3, 393);
      await Bun.sleep(30);
      return Response.json({ status: "ok", revision: "${revision}" });
    } });
    console.log("HTTP 正在监听 " + server.url.origin + "/status");
  `);

  expect(await scaledProbe(root, "await probe;")).toEqual([
    pluginStartupGraceMs, pluginStartupGraceMs + 500, pluginStartupGraceMs, pluginStartupGraceMs,
  ]);
  await expectReaped(root);
}));

test("取消隔离探测会等待清理，且隐藏取消原因", () => fixture(async (root) => {
  const pid = join(root, "pid");
  const reason = new Error("fixture abort cause stays private");
  await writeFile(join(root, "app.ts"), `
    process.on("SIGTERM", async () => {
      await Bun.write("stopped", "clean");
      process.exit(0);
    });
    await Bun.write("pid", String(process.pid));
    setInterval(() => {}, 1000);
  `);
  await expect(verifyUpdateHealth(root, revision, AbortSignal.abort(reason))).rejects.toThrow(failure);
  expect(await Bun.file(pid).exists()).toBe(false);

  const controller = new AbortController();
  const probe = verifyUpdateHealth(root, revision, controller.signal);
  void probe.catch(() => {});
  try {
    const deadline = performance.now() + 2_000;
    while (!await Bun.file(pid).exists() && performance.now() < deadline) await Bun.sleep(10);
    expect(await Bun.file(pid).exists()).toBe(true);
    controller.abort(reason);
    await expect(probe).rejects.toThrow(failure);
    expect(await readFile(join(root, "stopped"), "utf8")).toBe("clean");
    await expectReaped(root);
  } finally {
    controller.abort();
    await probe.catch(() => {});
  }
}));
