import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrateInstallation } from "../scripts/migrate.ts";

async function put(root: string, path: string, contents: string) {
  const filename = join(root, path);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, contents, { mode: 0o600 });
}

test.skipIf(!Bun.which("git"))("表情迁移只应用本机配置、预设和统计，原服务、戳图设置与目录仅归档", async () => {
  const folder = await mkdtemp(join(tmpdir(), "lotus-meme-migration-"));
  try {
    const source = join(folder, "old"), target = join(folder, "new");
    const plugin = "plugins/meme-plugin";
    const settings = `${plugin}/config/config`;
    const server = "backend: remote\nurl: https://service.example.invalid/private-fixture\ntimeout: 9\nmanagedTimeout: 32\n";
    await put(source, `${plugin}/package.json`, '{"name":"meme-plugin"}');
    await put(source, `${settings}/server.yaml`, server);
    await put(source, `${settings}/other.yaml`, "autoUpdateRes: true\nautoUpdateResCron: '0 0 1 * * *'\n");
    await put(source, `${settings}/access.yaml`, "enable: true\nblackList: [smile]\nuserBlackList: ['9988']\n");
    const legacyMeme = "pokeEnable: true\npokeProbability: 100\npokeLimit: 20\ncache: false\n";
    await put(source, `${settings}/meme.yaml`, legacyMeme);
    await put(source, `${settings}/stat.yaml`, "enable: false\n");
    await mkdir(join(source, plugin, "data"), { recursive: true });
    const originalDB = join(source, plugin, "data/data.db");
    {
      using db = new Database(originalDB, { create: true });
      db.exec(`
        CREATE TABLE meme (key TEXT PRIMARY KEY, tags TEXT, info TEXT);
        INSERT INTO meme VALUES ('pat', '[]', '{}'), ('fixture_denied', '["鸣潮"]', '{}');
        CREATE TABLE preset (name JSON PRIMARY KEY, key TEXT, arg_name TEXT, arg_value TEXT, createdAt TEXT, updatedAt TEXT);
        INSERT INTO preset VALUES ('"自用摸头"', 'pat', 'size', '150', 'created', 'updated');
        INSERT INTO preset VALUES ('"不得恢复"', 'fixture_denied', 'size', '150', 'created', 'updated');
        CREATE TABLE stat (key TEXT PRIMARY KEY, "all" INTEGER);
        INSERT INTO stat VALUES ('pat', 37), ('fixture_denied', 10);
      `);
    }
    const originalBytes = await readFile(originalDB);
    await put(target, "package.json", '{"name":"lotus-yunzai"}');
    await put(target, "plugins/.fixture", "fixture");
    for (const args of [["init", "-q"], ["add", "package.json", "plugins/.fixture"],
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
    }
    const result = await migrateInstallation(source, target);
    expect(result).toMatchObject({ status: "published", memeState: { settings: 4, presets: 1, statistics: 1, deferred: false } });
    const active = join(target, "data/meme/config");
    expect(Bun.YAML.parse(await readFile(join(active, "server.yaml"), "utf8"))).toEqual({ managedTimeout: 32 });
    expect(Bun.YAML.parse(await readFile(join(active, "access.yaml"), "utf8"))).toEqual({
      enable: true, userBlackList: ["9988"], blackList: ["smile"],
    });
    expect(Bun.YAML.parse(await readFile(join(active, "meme.yaml"), "utf8"))).toEqual({ cache: false });
    expect(Bun.YAML.parse(await readFile(join(active, "stat.yaml"), "utf8"))).toEqual({ enable: false });
    expect(await Bun.file(join(active, "other.yaml")).exists()).toBe(false);
    expect(await readFile(join(target, "backup", settings, "server.yaml"), "utf8")).toBe(server);
    expect(await readFile(join(target, "backup", settings, "meme.yaml"), "utf8")).toBe(legacyMeme);
    expect(await readFile(join(target, "backup", plugin, "data/data.db"))).toEqual(originalBytes);
    expect(await readFile(originalDB)).toEqual(originalBytes);
    {
      using db = new Database(join(target, "data/meme/data.db"), { readonly: true });
      expect(db.query("SELECT key FROM lotus_catalog_denied_keys").all()).toEqual([{ key: "fixture_denied" }]);
      expect(db.query("SELECT key, arg_value FROM preset").all()).toEqual([{ key: "pat", arg_value: "150" }]);
      expect(db.query('SELECT key, "all" FROM stat').all()).toEqual([{ key: "pat", all: 37 }]);
      expect(db.query("SELECT name FROM sqlite_schema WHERE name = 'meme'").get()).toBeNull();
    }
    const { publishMemeProvider } = await import("../plugins/meme/catalog-policy.ts");
    const { initializeLocalCatalog } = await import("../plugins/meme/catalog-update.ts");
    const oldData = Bun.env.LOTUS_MEME_DB, oldConfig = Bun.env.LOTUS_MEME_CONFIG_DIR;
    const release = publishMemeProvider({
      catalogIdentity: "fixture-native",
      async keys() { return ["pat", "fixture_denied"]; },
      async info(key) {
        return { key, keywords: [key], params_type: { min_images: 1, max_images: 1, min_texts: 0, max_texts: 0 } };
      },
      async generate() { return undefined; },
      async preview() { return undefined; },
    });
    try {
      Bun.env.LOTUS_MEME_CONFIG_DIR = active;
      Bun.env.LOTUS_MEME_DB = join(target, "data/meme/data.db");
      await expect(initializeLocalCatalog()).resolves.toContain("表情包数据更新完成");
      using db = new Database(Bun.env.LOTUS_MEME_DB, { readonly: true });
      expect(db.query('SELECT key, "all" FROM stat').all()).toEqual([{ key: "pat", all: 37 }]);
      expect(db.query("SELECT key, arg_value FROM preset WHERE name = ?").get('"自用摸头"')).toEqual({ key: "pat", arg_value: "150" });
      expect(db.query("SELECT key FROM lotus_catalog_denied_keys").all()).toEqual([{ key: "fixture_denied" }]);
    } finally {
      release();
      if (oldData === undefined) delete Bun.env.LOTUS_MEME_DB;
      else Bun.env.LOTUS_MEME_DB = oldData;
      if (oldConfig === undefined) delete Bun.env.LOTUS_MEME_CONFIG_DIR;
      else Bun.env.LOTUS_MEME_CONFIG_DIR = oldConfig;
    }
    await writeFile(join(active, "meme.yaml"), "cache: true\n");
    expect(await migrateInstallation(source, target)).toMatchObject({ status: "already-published" });
    expect(await readFile(join(active, "meme.yaml"), "utf8")).toBe("cache: true\n");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
