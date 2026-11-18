import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPluginLoading } from "../lib/plugin-load-progress.ts";
import { copyHost } from "./host-fixture.ts";

test("托管入口保持自身 PID，宿主清理后重启并在原终端继续操作", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-managed-host-"));
  try {
    await copyHost(root);
    await mkdir(join(root, "config", "config"), { recursive: true });
    await writeFile(join(root, "config", "config", "other.yaml"), 'master: ["stdin:stdin"]\n');
    const plugin = join(root, "plugins", "managed-fixture");
    await mkdir(plugin);
    await Promise.all([
      writeFile(join(plugin, "package.json"), JSON.stringify({
        name: "managed-fixture", type: "module", lotusYunzai: { entry: "./index.ts" },
      })),
      writeFile(join(plugin, "index.ts"), `
        console.log("managed worker " + process.pid);
        export default { commands: {}, dispose() { console.log("managed disposed " + process.pid); } };
      `),
    ]);
    const entry = fileURLToPath(new URL("../scripts/run-managed.ts", import.meta.url));
    const managed = Bun.spawn([process.execPath, entry, root], {
      cwd: root, env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 12_000, killSignal: "SIGKILL",
    });
    const reader = managed.stdout.getReader();
    const decoder = new TextDecoder();
    const stderr = new Response(managed.stderr).text();
    let output = "";
    async function waitFor(pattern: RegExp) {
      while (true) {
        const match = pattern.exec(output);
        if (match) {
          output = output.slice(match.index + match[0].length);
          return match;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`托管入口在响应前退出。\n${output}\n${await stderr}`);
        output += decoder.decode(chunk.value, { stream: true });
      }
    }
    function command(text: string) {
      managed.stdin.write(`${text}\n`);
      managed.stdin.flush();
    }
    try {
      const first = Number((await waitFor(/managed worker (\d+)/u))[1]);
      expect(first).not.toBe(managed.pid);
      await waitFor(/Lotus-Yunzai 已启动/u);
      command("#重启");
      await waitFor(/开始重启/u);
      expect(Number((await waitFor(/managed disposed (\d+)/u))[1])).toBe(first);
      const second = Number((await waitFor(/managed worker (\d+)/u))[1]);
      expect(second).not.toBe(first);
      expect(second).not.toBe(managed.pid);
      await waitFor(/重启成功，用时/u);
      command("#状态");
      await waitFor(/Lotus-Yunzai 正在运行/u);
      command("#停机");
      await waitFor(/开始停止/u);
      expect(await managed.exited).toBe(0);
    } finally {
      if (managed.exitCode === null && managed.signalCode === null) managed.kill("SIGTERM");
      await managed.exited;
      await reader.cancel();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(!Bun.which("git"))("已就绪的真实候选在托管提交前拒绝 HTTP 请求和 OneBot 连接", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-managed-held-"));
  try {
    await copyHost(root);
    function git(...args: string[]): string {
      const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgSign=false", ...args], {
        cwd: root, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      if (result.exitCode) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    }
    git("init", "--quiet");
    git("add", "app.ts");
    git("commit", "--quiet", "-m", "fixture");
    const revision = git("rev-parse", "HEAD");
    const token = crypto.randomUUID();
    const readiness = Promise.withResolvers<unknown>();
    const startup: number[] = [];
    const worker = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root,
      env: {
        PATH: process.env.PATH, LOTUS_MANAGED_TOKEN: token, LOTUS_MANAGED_HELD: "1",
        LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: "fixture-token",
      },
      stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 8_000, killSignal: "SIGKILL",
      ipc(message: unknown) {
        const wait = readPluginLoading(message, token, startup.length + 1);
        if (wait !== undefined) startup.push(wait);
        if (message && typeof message === "object" && "type" in message && message.type === "lotus-ready") {
          readiness.resolve(message);
        }
      },
    });
    const reader = worker.stdout.getReader();
    const decoder = new TextDecoder();
    async function waitForHttp() {
      let output = "";
      for (;;) {
        const match = /http:\/\/127\.0\.0\.1:\d+\/status/u.exec(output);
        if (match) return match[0];
        const chunk = await reader.read();
        if (chunk.done) throw new Error("候选未监听 HTTP。");
        output += decoder.decode(chunk.value, { stream: true });
      }
    }
    try {
      const [notice, status] = await Promise.all([Promise.race([readiness.promise, worker.exited]), waitForHttp()]);
      expect(notice).toMatchObject({ type: "lotus-ready", token, revision, plugins: ["system"] });
      expect(startup).toEqual([60_000, 0]);
      const gateway = new URL("/OneBotv11", status);
      const headers = { Authorization: "Bearer fixture-token", "X-Client-Role": "Universal" };
      expect((await fetch(status)).status).toBe(503);
      expect((await fetch(gateway, { headers })).status).toBe(503);
      worker.send({ type: "lotus-activate", token });
      const end = performance.now() + 2_000;
      let response = await fetch(status);
      while (response.status === 503 && performance.now() < end) {
        await Bun.sleep(10);
        response = await fetch(status);
      }
      expect(await response.json()).toMatchObject({ status: "ok", revision });
      expect((await fetch(gateway, { headers })).status).toBe(426);
      worker.kill("SIGTERM");
      expect(await worker.exited).toBe(143);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
      await worker.exited;
      await reader.cancel();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
