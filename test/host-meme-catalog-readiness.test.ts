import { Database, SQLiteError } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnManagedWorker } from "../lib/managed-worker.ts";
import { pluginProbeTokenEnvironment } from "../lib/plugin-load-progress.ts";
import { nativeCatalogTable } from "../plugins/meme/catalog-file.ts";
import { copyHost, linkHostPackages } from "./host-fixture.ts";

async function waitFor<T>(read: () => T | Promise<T>) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const result = await read();
    if (result) return result;
    await Bun.sleep(20);
  }
  throw new Error("表情目录未在预期时间内完成同步。");
}

const git = Bun.which("git");

test.skipIf(!git || process.platform === "win32")("受管宿主接管后才建立本机表情目录，旧定时配置不访问远端", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-host-meme-"));
  const config = join(root, "config", "meme");
  const file = join(root, "data", "meme", "data.db");
  const requests: string[] = [];
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return new Response(null, { status: 503 });
  } });
  function catalog() {
    const db = new Database(file, { readonly: true });
    try {
      if (!db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(nativeCatalogTable)) return;
      return db.query<{ key: string }, []>(`SELECT key FROM ${nativeCatalogTable} ORDER BY key`).all().map(({ key }) => key);
    } catch (error) {
      // The worker can hold an exclusive lock while committing a catalog refresh.
      if (error instanceof SQLiteError && error.code === "SQLITE_BUSY") return;
      throw error;
    } finally {
      db.close();
    }
  }
  try {
    await copyHost(root);
    await linkHostPackages(root);
    const source = fileURLToPath(new URL("../plugins/meme", import.meta.url));
    const destination = join(root, "plugins", "meme");
    const linked = ["node_modules", "resources/builtin"];
    await cp(source, destination, {
      recursive: true,
      filter: path => path !== join(source, ".git") && !linked.some(relative => path === join(source, relative)),
    });
    await Promise.all(linked.map(relative => symlink(join(source, relative), join(destination, relative), "dir")));
    function gitRun(...args: string[]) {
      const result = Bun.spawnSync([git!, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    }
    gitRun("init", "--quiet", "--template=");
    gitRun("-c", "user.name=Lotus Test", "-c", "user.email=test@invalid", "commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", "test");
    const revision = gitRun("rev-parse", "HEAD");
    await mkdir(config, { recursive: true });
    await writeFile(join(root, "config/bot.yaml"), "log_level: debug\n");
    await writeFile(join(config, "other.yaml"), 'autoUpdateRes: true\nautoUpdateResCron: "* * * * * ?"\n');
    await writeFile(join(config, "server.yaml"), `backend: remote\nurl: ${service.url.href}\n`);
    const fixtureEnv = { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0", LOTUS_MEME_DB: file, LOTUS_MEME_CONFIG_DIR: config,
      LOTUS_MEME_SERVER_URL: service.url.href };
    const probeToken = crypto.randomUUID();
    const listener = Promise.withResolvers<void>();
    const probe = Bun.spawn([process.execPath, "app.ts"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...fixtureEnv, [pluginProbeTokenEnvironment]: probeToken },
      ipc(message) {
        if (message?.type === "lotus-yunzai-probe-listener" && message.token === probeToken &&
            message.host === "127.0.0.1" && Number.isInteger(message.port) && message.port > 0) listener.resolve();
      },
    });
    const stdout = new Response(probe.stdout).text(), stderr = new Response(probe.stderr).text();
    const timer = setTimeout(() => listener.reject(new Error("探测宿主未报告完成加载。")), 4_000);
    try {
      await Promise.race([listener.promise, probe.exited.then(async () => { throw new Error(await stderr); })]);
    } finally {
      clearTimeout(timer);
      probe.kill("SIGTERM");
      await probe.exited;
    }
    expect(await stdout + await stderr).toMatch(/加载插件\s*\[meme\]/u);
    expect(await Bun.file(file).exists()).toBe(false);

    const env = { ...fixtureEnv, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: "meme-readiness-fixture" };
    const worker = spawnManagedWorker(root, { held: true, expectedRevision: revision, expectedPlugins: ["meme"], env });
    try {
      await worker.ready;
      await Bun.sleep(1_050);
      expect(requests).toEqual([]);
      expect(await Bun.file(file).exists()).toBe(false);
      worker.activate();
      const installed = await waitFor(async () => await Bun.file(file).exists() ? catalog() : undefined);
      expect(installed).toContain("petpet");
      expect(installed).toContain("flush");
      await Bun.sleep(1_050);
      expect(await waitFor(catalog)).toEqual(installed);
      expect(requests).toEqual([]);
    } finally {
      await worker.stop();
    }
  } finally {
    await service.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
