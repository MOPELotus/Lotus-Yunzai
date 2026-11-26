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
    ["data/custom/history.bin", original], ["data/node_modules/history.json", Buffer.from('{"history":1}')],
    ["data/.git/config", Buffer.from("fixture")]] as const) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), value);
  }
  await mkdir(join(stage, "data"));
  await writeFile(join(stage, "data/current.json"), "new state");
  const report = await stageMigrationSourceSnapshot(source, stage);
  expect(report).toMatchObject({ version: 1, files: 4, unresolved: [] });
  expect(await readFile(join(stage, report.path, "data/custom/history.bin"))).toEqual(original);
  expect(await readFile(join(source, "data/custom/history.bin"))).toEqual(original);
  expect(await readFile(join(stage, report.path, "data/node_modules/history.json"), "utf8")).toBe('{"history":1}');
  expect(await readFile(join(stage, report.path, "data/.git/config"), "utf8")).toBe("fixture");
  expect(await readFile(join(stage, "data/current.json"), "utf8")).toBe("new state");
  const manifest = JSON.parse(await readFile(join(stage, report.path, "manifest.json"), "utf8"));
  expect(manifest.entries).toContainEqual({ path: "data/custom/history.bin", kind: "file", bytes: original.length,
    sha256: createHash("sha256").update(original).digest("hex") });
  expect((await lstat(join(stage, report.path))).mode & 0o777).toBe(0o700);
  expect((await lstat(join(stage, report.path, "data/custom/history.bin"))).mode & 0o777).toBe(0o600);
}));

async function syncCommand(parent: string, script: string, run: () => Promise<void>) {
  const bin = join(parent, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "sync"), "#!/bin/sh\n" + script, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = bin + ":" + previous;
  try { await run(); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
}

test.skipIf(process.platform !== "linux" || !Bun.which("sync"))("source-snapshot-syncfs-failure", () => fixture(async (source, stage, parent) => {
  await mkdir(join(source, "data"));
  await writeFile(join(source, "data/value.json"), '{"value":1}');
  const counter = join(parent, "counter"), realSync = Bun.which("sync")!;
  await syncCommand(parent, `printf x >> '${counter}'\nif [ "$(wc -c < '${counter}')" -gt 1 ]; then exit 9; fi\nexec '${realSync}' "$@"\n`, async () => {
    await expect(stageMigrationSourceSnapshot(source, stage)).rejects.toThrow("EIO");
    expect(await readFile(counter, "utf8")).toBe("xx");
    await expect(lstat(join(stage, "backup/migration-source"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(source, "data/value.json"), "utf8")).toBe('{"value":1}');
  });
}));

test.skipIf(process.platform !== "linux")("source-snapshot-syncfs-unavailable", () => fixture(async (source, stage, parent) => {
  await mkdir(join(source, "data"));
  await writeFile(join(source, "data/value.json"), '{"value":1}');
  const counter = join(parent, "counter");
  await syncCommand(parent, `printf x >> '${counter}'\nexit 64\n`, async () => {
    const report = await stageMigrationSourceSnapshot(source, stage);
    expect(report.files).toBe(1);
    expect(await readFile(counter, "utf8")).toBe("x");
    const manifest = JSON.parse(await readFile(join(stage, report.path, "manifest.json"), "utf8"));
    expect(manifest.entries.find((entry: { path: string }) => entry.path === "data/value.json").sha256)
      .toBe(createHash("sha256").update('{"value":1}').digest("hex"));
    expect(await readFile(join(stage, report.path, "data/value.json"), "utf8")).toBe('{"value":1}');
  });
}));

test.skipIf(process.platform !== "linux" || !Bun.which("sync"))("source-snapshot-syncfs-source-change", () => fixture(async (source, stage, parent) => {
  await mkdir(join(source, "data"));
  const value = join(source, "data/value.json");
  await writeFile(value, '{"value":1}');
  const counter = join(parent, "counter"), realSync = Bun.which("sync")!;
  await syncCommand(parent, `printf x >> '${counter}'\nif [ "$(wc -c < '${counter}')" -gt 1 ]; then printf '{"value":2}' > '${value}'; fi\nexec '${realSync}' "$@"\n`, async () => {
    await expect(stageMigrationSourceSnapshot(source, stage)).rejects.toMatchObject({ reason: "changed" });
    expect(await readFile(counter, "utf8")).toBe("xx");
    await expect(lstat(join(stage, "backup/migration-source"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(value, "utf8")).toBe('{"value":2}');
  });
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
