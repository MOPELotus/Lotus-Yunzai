import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnManagedWorker } from "../lib/managed-worker.ts";
import { pluginProbeTokenEnvironment } from "../lib/plugin-load-progress.ts";
import { copyHost } from "./host-fixture.ts";

async function waitFor(ready: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    if (await ready()) return;
    await Bun.sleep(20);
  }
  throw new Error("表情目录未在预期时间内完成同步。");
}

const git = Bun.which("git");

test.skipIf(!git || process.platform === "win32")("表情安装和定时同步只在受管宿主接管后运行", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-host-meme-"));
  const config = join(root, "config", "meme");
  const file = join(root, "data", "meme", "data.db");
  const requests: string[] = [];
  let keys = ["ba_say"];
  let broken = false;
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/memes/keys") return Response.json(keys);
    const key = /^\/memes\/([^/]+)\/info$/u.exec(path)?.[1];
    if (!key || (broken && key === "new")) return new Response(null, { status: 503 });
    return Response.json({ key, keywords: [key], params_type: { min_texts: 0, max_texts: 0, min_images: 0, max_images: 0 } });
  } });
  function catalog() {
    const db = new Database(file, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 250");
      return db.query<{ key: string }, []>("SELECT key FROM meme ORDER BY key").all().map(({ key }) => key);
    }
    finally { db.close(); }
  }
  try {
    await copyHost(root);
    await cp(new URL("../plugins/meme", import.meta.url), join(root, "plugins", "meme"), {
      recursive: true, filter: path => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
    });
    function gitRun(...args: string[]) {
      const result = Bun.spawnSync([git!, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    }
    gitRun("init", "--quiet", "--template=");
    gitRun("-c", "user.name=Lotus Test", "-c", "user.email=test@invalid", "commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", "test");
    const revision = gitRun("rev-parse", "HEAD");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "other.yaml"), 'autoUpdateRes: true\nautoUpdateResCron: "* * * * * ?"\n');
    const fixtureEnv = { PATH: process.env.PATH, LOTUS_MEME_DB: file, LOTUS_MEME_CONFIG_DIR: config,
      LOTUS_MEME_SERVER_URL: service.url.href };
    const probe = Bun.spawn([process.execPath, "app.ts"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...fixtureEnv, [pluginProbeTokenEnvironment]: crypto.randomUUID() } });
    const [stdout, stderr, exit] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]);
    if (exit !== 0) throw new Error(stderr);
    expect(stdout + stderr).toContain("已加载 meme");
    expect(await Bun.file(file).exists()).toBe(false);

    const env = { ...fixtureEnv, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: "meme-readiness-fixture" };
    const worker = spawnManagedWorker(root, { held: true, expectedRevision: revision, expectedPlugins: ["meme"], env });
    try {
      await worker.ready;
      await Bun.sleep(1_050);
      expect(requests).toEqual([]);
      expect(await Bun.file(file).exists()).toBe(false);
      worker.activate();
      await waitFor(() => Bun.file(file).exists());
      expect(catalog()).toEqual(["ba_say"]);
      expect(requests.filter(path => path === "/memes/ba_say/info")).toHaveLength(1);

      keys = ["ba_say", "new"];
      broken = true;
      await waitFor(() => requests.includes("/memes/new/info"));
      expect(catalog()).toEqual(["ba_say"]);
      broken = false;
      await waitFor(() => catalog().includes("new"));
      expect(catalog()).toEqual(["ba_say", "new"]);
      expect(requests.filter(path => path === "/memes/ba_say/info")).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  } finally {
    await service.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
