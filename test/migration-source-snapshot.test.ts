import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stageMigrationSourceSnapshot } from "../lib/migration-source-snapshot.ts";

async function fixture(run: (source: string, stage: string, parent: string) => Promise<void>) {
  const parent = await mkdtemp(join(tmpdir(), "lotus-source-snapshot-"));
  const source = join(parent, "old"), stage = join(parent, "stage");
  try {
    await mkdir(source, { mode: 0o700 });
    await mkdir(stage, { mode: 0o700 });
    await run(source, stage, parent);
  } finally { await rm(parent, { recursive: true, force: true }); }
}

test("source snapshot retains unmapped source bytes and private hashes independently of active data", () => fixture(async (source, stage) => {
  const original = Buffer.alloc(300_000, 71);
  for (const [path, value] of [["config/config/bot.yaml", Buffer.from("# original\r\nupdate_time: 17\r\n")],
    ["data/custom/history.bin", original]] as const) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), value);
  }
  await mkdir(join(stage, "data"));
  await writeFile(join(stage, "data/current.json"), "new state");
  const report = await stageMigrationSourceSnapshot(source, stage);
  expect(report).toMatchObject({ version: 1, files: 2, unresolved: [] });
  expect(await readFile(join(stage, report.path, "data/custom/history.bin"))).toEqual(original);
  expect(await readFile(join(source, "data/custom/history.bin"))).toEqual(original);
  expect(await readFile(join(stage, "data/current.json"), "utf8")).toBe("new state");
  const manifest = JSON.parse(await readFile(join(stage, report.path, "manifest.json"), "utf8"));
  expect(manifest.entries).toContainEqual({ path: "data/custom/history.bin", kind: "file", bytes: original.length,
    sha256: createHash("sha256").update(original).digest("hex") });
  expect((await lstat(join(stage, report.path))).mode & 0o777).toBe(0o700);
  expect((await lstat(join(stage, report.path, "data/custom/history.bin"))).mode & 0o777).toBe(0o600);
}));

test("source links are recorded as unresolved without copying or following external content", () => fixture(async (source, stage, parent) => {
  const foreign = join(parent, "external");
  await writeFile(foreign, "external private content");
  await mkdir(join(source, "data"));
  await symlink(foreign, join(source, "data/linked"));
  const report = await stageMigrationSourceSnapshot(source, stage);
  expect(report.files).toBe(0);
  expect(report.unresolved).toEqual([{ path: "data/linked", kind: "symlink" }]);
  expect(await Bun.file(join(stage, report.path, "data/linked")).exists()).toBe(false);
  const manifest = JSON.parse(await readFile(join(stage, report.path, "manifest.json"), "utf8"));
  expect(manifest.entries).toContainEqual({ path: "data/linked", kind: "symlink", target: foreign });
  expect(await readFile(foreign, "utf8")).toBe("external private content");
}));

test("snapshot rejects overlapping paths and observes cancellation without touching source", () => fixture(async (source, stage) => {
  await expect(stageMigrationSourceSnapshot(source, source)).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(stageMigrationSourceSnapshot(source, stage, controller.signal)).rejects.toThrow();
  expect(await Bun.file(join(stage, "backup/migration-source/manifest.json")).exists()).toBe(false);
}));
