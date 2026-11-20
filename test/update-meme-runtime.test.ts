import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateUpdate, previousUpdateDirectory } from "../lib/update-activation.ts";
import { readUpdateRuntimePaths, verifyMovedRuntimePaths } from "../lib/update-runtime-paths.ts";
import { readMemeUsage, recordMemeUsage } from "../plugins/meme/usage.ts";

function leaveCommittedWal(file: string, key: string, count: number): string {
  const writer = Bun.spawnSync([
    process.execPath, "-e", `
      import { Database } from "bun:sqlite";
      const [file, key, count] = process.argv.slice(1);
      const db = new Database(file);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      db.query('INSERT INTO stat VALUES (?, ?)').run(key, Number(count));
      console.log(db.query("PRAGMA database_list").get().file);
      process.kill(process.pid, "SIGKILL");
    `, file, key, String(count),
  ]);
  expect(writer.signalCode).toBe("SIGKILL");
  return writer.stdout.toString().trimEnd();
}

function counts(catalog: string) {
  const db = new Database(catalog, { readonly: true });
  try {
    return Object.fromEntries(readMemeUsage(db, catalog));
  } finally {
    db.close();
  }
}

for (const layout of ["直接路径", "库文件通过外置多级链接", "父目录通过外置多级链接", "库文件链接随 data 移交"] as const) {
  test.skipIf(process.platform === "win32")(`受管切换保留表情目录和独立统计及两组 WAL（${layout}）`, async () => {
    const work = await mkdtemp(join(tmpdir(), "lotus-update-meme-"));
    const active = join(work, "active");
    const next = join(work, "next");
    const storage = join(active, "meme-state");
    const outside = join(work, "links");
    const config = join(work, "config");
    const realCatalog = join(storage, "catalog.db");
    const prior = Bun.env.LOTUS_MEME_CONFIG_DIR;
    try {
      await Promise.all([storage, next, outside, config].map(path => mkdir(path, { recursive: true })));
      await Bun.write(join(config, "stat.yaml"), "enable: true\n");
      Bun.env.LOTUS_MEME_CONFIG_DIR = config;
      const db = new Database(realCatalog);
      try {
        db.exec('CREATE TABLE stat(key TEXT PRIMARY KEY NOT NULL, "all" INTEGER NOT NULL)');
        db.query('INSERT INTO stat VALUES (?, ?)').run("catalog", 7);
      } finally {
        db.close();
      }

      let catalog = realCatalog;
      if (layout === "库文件通过外置多级链接") {
        await symlink(realCatalog, join(outside, "second.db"));
        await symlink("second.db", join(outside, "first.db"));
        catalog = join(outside, "first.db");
      } else if (layout === "父目录通过外置多级链接") {
        await symlink(storage, join(outside, "second-directory"));
        await symlink("second-directory", join(outside, "first-directory"));
        catalog = join(outside, "first-directory", "catalog.db");
      } else if (layout === "库文件链接随 data 移交") {
        await mkdir(join(active, "data"));
        catalog = join(active, "data", "catalog.db");
        await symlink("../meme-state/catalog.db", catalog);
      }

      recordMemeUsage("usage", catalog);
      recordMemeUsage("usage", catalog);
      expect(counts(catalog)).toEqual({ catalog: 7, usage: 2 });
      const usage = catalog + ".usage.sqlite";
      const physicalUsage = await realpath(usage);
      expect(physicalUsage).toBe(layout === "父目录通过外置多级链接" ? realCatalog + ".usage.sqlite" : usage);
      expect(leaveCommittedWal(catalog, "catalog-wal", 8)).toBe(realCatalog);
      expect(leaveCommittedWal(usage, "usage-wal", 9)).toBe(physicalUsage);
      for (const file of [realCatalog, physicalUsage]) {
        for (const suffix of ["-wal", "-shm"]) expect(await Bun.file(file + suffix).exists()).toBe(true);
      }

      const env = { LOTUS_MEME_DB: catalog };
      const paths = await readUpdateRuntimePaths(active, AbortSignal.timeout(3_000), env);
      const verify = async (root: string) => {
        const previous = await previousUpdateDirectory(root);
        expect(previous).toBeDefined();
        await verifyMovedRuntimePaths(root, previous!, env);
      };
      const oldPaths = layout === "直接路径"
        ? ["meme-state/catalog.db", "meme-state/catalog.db-wal", "meme-state/catalog.db-shm"] : [];
      await expect(activateUpdate(active, next, verify, oldPaths)).rejects.toThrow("仍留在旧版本");
      const result = await activateUpdate(active, next, verify, paths);
      expect(await Bun.file(join(result.previous, "meme-state", "catalog.db.usage.sqlite")).exists()).toBe(false);
      expect(counts(catalog)).toEqual({ catalog: 7, "catalog-wal": 8, usage: 2, "usage-wal": 9 });
    } finally {
      if (prior === undefined) delete Bun.env.LOTUS_MEME_CONFIG_DIR;
      else Bun.env.LOTUS_MEME_CONFIG_DIR = prior;
      await rm(work, { recursive: true, force: true });
    }
  });
}
