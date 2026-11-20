import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnManagedWorker } from "../lib/managed-worker.ts";
import { pluginProbeTokenEnvironment } from "../lib/plugin-load-progress.ts";
import { copyHost } from "./host-fixture.ts";

const git = Bun.which("git");

test.skipIf(!git || process.platform === "win32")("摩拉自动刷新在插件探针和待激活宿主不写入，正式接管后启动", async () => {
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
    const env = { PATH: [bin, process.env.PATH].join(delimiter), LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0",
      LOTUS_ONEBOT_TOKEN: "guides-readiness-fixture",
      LOTUS_GUIDES_AUTO_UPDATE: "1", LOTUS_GUIDES_TEAM_DIR: "" };
    const resource = Bun.file(join(root, "data", "guides", "mora", "refresh.lock"));
    const probe = Bun.spawn([process.execPath, "app.ts"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: env.PATH, LOTUS_GUIDES_AUTO_UPDATE: "1", [pluginProbeTokenEnvironment]: crypto.randomUUID() } });
    const [stdout, stderr, exit] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]);
    if (exit !== 0) throw new Error(stderr);
    expect(stdout + stderr).toContain("已加载 guides");
    expect(await resource.exists()).toBe(false);

    const worker = spawnManagedWorker(root, { held: true, expectedRevision: revision, expectedPlugins: ["guides"], env });
    try {
      await worker.ready;
      await Bun.sleep(120);
      expect(await resource.exists()).toBe(false);
      worker.activate();
      const deadline = performance.now() + 4_000;
      while (!await resource.exists() && performance.now() < deadline) await Bun.sleep(15);
      expect(await resource.exists()).toBe(true);
    } finally {
      await worker.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
