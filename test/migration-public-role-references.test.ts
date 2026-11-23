import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { stageLegacyOfficialBindings } from "../lib/migration-official-bindings.ts";
import { createPublicRoleReferences, matchPublicRoleReferenceCommand } from "../lib/public-role-references.ts";
import { migrateInstallation } from "../scripts/migrate.ts";

const archived = "backup/legacy-official-bindings";
const reference = "data/public-role-references";
const existingReferences = { gs: { uid: "100000046", data: ["100000046"] }, sr: { uid: "", data: [] }, zzz: { uid: "", data: [] } };
const legacy = JSON.stringify({
  gs: { uid: "100000047", data: {
    "100000047": { uid: "100000047", type: "reg" },
    "100000045": { uid: "100000045", type: "reg" },
    "100000048": { uid: "100000048", type: "ck" },
    "100000049": { uid: "100000050", type: "reg" },
    "100000002": { uid: "100000002", type: "reg" },
  } },
  sr: { uid: "100000048", data: { "100000043": { uid: "100000043", type: "reg" } } },
  zzz: { uid: "82000042", data: { "82000042": { uid: "82000042", type: "reg" } } },
});
const expected = {
  version: 1,
  gs: { uid: "100000047", data: ["100000045", "100000047"] },
  sr: { uid: "100000043", data: ["100000043"] },
  zzz: { uid: "82000042", data: ["82000042"] },
};
const a41 = join(reference, "41", "1.json"), a42 = join(reference, "42", "1.json");

async function fixture(run: (old: string, next: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-migrate-public-role-"));
  const old = join(temporary, "old"), next = join(temporary, "next");
  try {
    await mkdir(join(old, "data", "db"), { recursive: true });
    await mkdir(join(old, "plugins"));
    await mkdir(next);
    await run(old, next);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function snapshot(old: string, schema = true, wal = true) {
  const directory = await mkdtemp(join(dirname(old), "source-db-"));
  const file = join(directory, "data.db");
  const db = new Database(file);
  try {
    if (schema) {
      db.run("CREATE TABLE Users (id VARCHAR PRIMARY KEY, type VARCHAR DEFAULT 'qq', ltuids VARCHAR, games VARCHAR)");
      db.run("CREATE TABLE MysUsers (ltuid INTEGER PRIMARY KEY, ck TEXT)");
    } else db.run("CREATE TABLE Other (id TEXT)");
    if (wal) {
      db.run("PRAGMA journal_mode=WAL");
      db.run("PRAGMA wal_autocheckpoint=0");
    }
    if (schema) {
      const insert = db.query("INSERT INTO Users (id, type, ltuids, games) VALUES (?, ?, ?, ?)");
      insert.run("41", "qq", "287", legacy);
      insert.run("42", "qq", "287", legacy);
      insert.run("43", "redactedOtherAdapter", "", legacy);
      insert.run("44", "qq", "", "{ invalid");
      insert.run("45", "qq", "", JSON.stringify({ gs: { uid: "100000048", data: { "100000048": { uid: "100000048", type: "ck" } } } }));
      insert.run("9007199254740992", "qq", "", legacy);
      db.run("INSERT INTO MysUsers VALUES (287, 'fixture-secret-never-migrate')");
    }
    const suffixes = wal ? ["", "-wal", "-shm"] : [""];
    const bytes = new Map<string, Buffer<ArrayBuffer>>();
    for (const suffix of suffixes) {
      const raw = await readFile(file + suffix);
      await writeFile(join(old, "data/db", "data.db" + suffix), raw);
      bytes.set(suffix, raw);
    }
    return bytes;
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("从已校验 WAL 只迁 reg，准确恢复各游戏的旧序号和当前，已存在档原样保留", () => fixture(async (old, next) => {
  const source = await snapshot(old);
  const existing = JSON.stringify({ version: 1, ...existingReferences });
  await mkdir(dirname(join(next, a41)), { recursive: true });
  await writeFile(join(next, a41), existing);
  const result = await stageLegacyOfficialBindings(old, next);
  expect(result).toEqual({ type: "sqlite-with-wal", files: 2, publicRoleReferences: { imported: 1, existing: 1, invalid: 6 } });
  expect(await readFile(join(next, a41), "utf8")).toBe(existing);
  expect(JSON.parse(await readFile(join(next, a42), "utf8"))).toEqual(expected);
  expect((await lstat(join(next, a42))).mode & 0o777).toBe(0o600);
  expect((await readdir(join(next, reference))).sort()).toEqual(["41", "42"]);
  expect(await readdir(dirname(join(next, a42)))).toEqual(["1.json"]);
  expect(await readFile(join(next, archived, "data.db"))).toEqual(source.get("")!);
  expect(await readFile(join(next, archived, "data.db-wal"))).toEqual(source.get("-wal")!);
  expect(await readFile(join(old, "data/db/data.db"))).toEqual(source.get("")!);
  expect(await readFile(join(old, "data/db/data.db-wal"))).toEqual(source.get("-wal")!);
  const runtime = createPublicRoleReferences(lockFile, join(next, reference));
  const list = await runtime(matchPublicRoleReferenceCommand("#公开UID列表")!,
    { user: 42, signal: new AbortController().signal, isCurrent: () => true });
  expect(list).toContain("1. 100000045");
  expect(list).toContain("2. 100000047（当前）");
  expect(list).toContain("1. 100000043（当前）");
  expect(list).not.toContain("fixture-secret");
  expect(list).not.toContain("100000048");
}));

test("数据库缺旧表或 WAL 不完整时保留快照，跳过公开 UID 导入", () => fixture(async (old, next) => {
  await snapshot(old, false, false);
  expect(await stageLegacyOfficialBindings(old, next)).toEqual({ type: "sqlite", files: 1 });
  expect(await Bun.file(join(next, a42)).exists()).toBe(false);
  const plain = join(dirname(next), "plain");
  await mkdir(plain);
  await snapshot(old, true, false);
  expect(await stageLegacyOfficialBindings(old, plain)).toEqual({
    type: "sqlite", files: 1, publicRoleReferences: { imported: 2, existing: 0, invalid: 6 },
  });
  expect(JSON.parse(await readFile(join(plain, a42), "utf8"))).toEqual(expected);
  const broken = join(dirname(next), "broken");
  await mkdir(broken);
  const source = await snapshot(old);
  await writeFile(join(old, "data/db/data.db-wal"), source.get("-wal")!.subarray(0, -12));
  expect(await stageLegacyOfficialBindings(old, broken)).toEqual({ type: "incomplete", files: 2 });
  expect(await Bun.file(join(broken, a42)).exists()).toBe(false);
  expect(await Bun.file(join(broken, archived, "data.db")).exists()).toBe(true);
}));

async function prepareCheckout(path: string) {
  await mkdir(join(path, "plugins", "system"), { recursive: true });
  await writeFile(join(path, "package.json"), '{"name":"lotus-yunzai"}');
  await writeFile(join(path, "plugins/system/package.json"), '{"name":"@lotus-yunzai/system"}');
  for (const args of [["init", "-q"], ["add", "package.json", "plugins"], [
    "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture",
  ]]) {
    const git = Bun.spawnSync(["git", ...args], { cwd: path, stdout: "ignore", stderr: "ignore" });
    expect(git.exitCode).toBe(0);
  }
}

test("正常迁移一次发布旧 reg 引用，目标已有资料不会覆盖，完成重跑保持用户删除", () => fixture(async (old, next) => {
  await snapshot(old);
  const occupied = join(dirname(next), "occupied");
  await prepareCheckout(next);
  await prepareCheckout(occupied);
  await mkdir(dirname(join(occupied, a42)), { recursive: true });
  await writeFile(join(occupied, a42), JSON.stringify({ version: 1, ...existingReferences }));
  const original = await readFile(join(occupied, a42));
  await expect(migrateInstallation(old, occupied)).rejects.toThrow(/目标已有 data/u);
  expect(await readFile(join(occupied, a42))).toEqual(original);
  expect(await Bun.file(join(occupied, archived, "data.db")).exists()).toBe(false);

  const published = await migrateInstallation(old, next);
  expect(published.status).toBe("published");
  expect(published.officialBindings).toMatchObject({ publicRoleReferences: { imported: 2, existing: 0, invalid: 6 } });
  expect(JSON.parse(await readFile(join(next, a42), "utf8"))).toEqual(expected);
  await rm(join(next, a42));
  const repeated = await migrateInstallation(old, next);
  expect(repeated.status).toBe("already-published");
  expect(await Bun.file(join(next, a42)).exists()).toBe(false);
}), 12_000);
