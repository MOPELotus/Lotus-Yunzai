import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnManagedWorker } from "../lib/managed-worker.ts";
import { pluginProbeTokenEnvironment } from "../lib/plugin-load-progress.ts";
import { copyHost } from "./host-fixture.ts";

const git = Bun.which("git");

test.skipIf(!git || process.platform === "win32")("摩拉自动刷新在插件探针和待激活宿主不写入，正式接管后才注册并执行定时刷新", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-guides-managed-readiness-"));
  try {
    await copyHost(root);
    await cp(new URL("../plugins/guides", import.meta.url), join(root, "plugins", "guides"), {
      recursive: true, filter: path => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
    });
    const run = (...args: string[]) => {
      const result = Bun.spawnSync([git!, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    run("init", "--quiet", "--template=");
    run("-c", "user.name=Lotus Test", "-c", "user.email=test@invalid",
      "commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", "test");
    const revision = run("rev-parse", "HEAD");
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "git"), `#!/bin/sh
for arg do
  [ "$arg" != "--bare" ] || exit 1
done
exec "${git}" "$@"
`, { mode: 0o700 });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/bot.yaml"), "log_level: debug\n");
    const app = join(root, "app.ts");
    await Bun.write(app, `
import { Job } from "node-schedule";
import { writeFileSync } from "node:fs";
const fixtureSchedule = Job.prototype.schedule;
Job.prototype.schedule = function (spec) {
  const result = fixtureSchedule.call(this, spec);
  if (this.name.startsWith("lotus-guides-team-refresh-")) {
    if (spec.rule !== "0 0 2,14 * * *" || spec.tz !== "Asia/Shanghai") throw Error("攻略定时排期错误");
    writeFileSync("team-schedule-registered", "02:00/14:00");
    setTimeout(() => this.invoke(), 0); // Simulate a due tick after the real activation hook registers the job.
  }
  return result;
};
const fixtureFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return fixtureFetch(input, init);
  await Bun.write("unexpected-http-network", url.origin + url.pathname);
  throw Error("managed guides fixture forbids remote requests");
};
` + await Bun.file(app).text());
    const env = { GIT_ALLOW_PROTOCOL: "file", PATH: [bin, process.env.PATH].join(delimiter), LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0",
      LOTUS_ONEBOT_TOKEN: "guides-readiness-fixture",
      LOTUS_GUIDES_AUTO_UPDATE: "1", LOTUS_GUIDES_TEAM_DIR: "" };
    const resource = Bun.file(join(root, "data", "guides", "mora", "refresh.lock"));
    const probeToken = crypto.randomUUID();
    const listener = Promise.withResolvers<void>();
    const probe = Bun.spawn([process.execPath, "app.ts"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...env, [pluginProbeTokenEnvironment]: probeToken },
      ipc(message) {
        if (message?.type === "lotus-yunzai-probe-listener" && message.token === probeToken &&
            message.host === "127.0.0.1" && Number.isInteger(message.port) && message.port > 0) listener.resolve();
      },
    });
    const stdout = new Response(probe.stdout).text(), stderr = new Response(probe.stderr).text();
    const timer = setTimeout(() => listener.reject(new Error("攻略探测宿主未完成加载。")), 4_000);
    try {
      await Promise.race([listener.promise, probe.exited.then(async () => { throw new Error(await stderr); })]);
    } finally {
      clearTimeout(timer);
      probe.kill("SIGTERM");
      await probe.exited;
    }
    expect(await stdout + await stderr).toMatch(/加载插件\s*\[guides\]/u);
    expect(await resource.exists()).toBe(false);
    expect(await Bun.file(join(root, "team-schedule-registered")).exists()).toBe(false);

    const worker = spawnManagedWorker(root, { held: true, expectedRevision: revision, expectedPlugins: ["guides"], env });
    try {
      await worker.ready;
      await Bun.sleep(120);
      expect(await resource.exists()).toBe(false);
      expect(await Bun.file(join(root, "team-schedule-registered")).exists()).toBe(false);
      worker.activate();
      const deadline = performance.now() + 4_000;
      while (!await resource.exists() && performance.now() < deadline) await Bun.sleep(15);
      expect(await resource.exists()).toBe(true);
      expect(await Bun.file(join(root, "team-schedule-registered")).text()).toBe("02:00/14:00");
      expect(await Bun.file(join(root, "unexpected-http-network")).exists()).toBe(false);
    } finally {
      await worker.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
