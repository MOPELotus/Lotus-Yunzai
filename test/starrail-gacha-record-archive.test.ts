import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { createStarRailGachaRecordArchive } from "../plugins/starrail/gacha-record-archive.ts";
import type { StarRailUigfArchive, StarRailUigfPool, StarRailUigfRow } from "../plugins/starrail/gacha-uigf.ts";

const identity = { qq: "42", uid: "100000002" };
const options = { legacyTimezone: 8 };
const unchanged = async () => {};
const pools = ["1", "2", "11", "12", "21", "22"] as const;

function draw(id: string, gacha_type: StarRailUigfPool = "11", fields: Partial<StarRailUigfRow> = {}): StarRailUigfRow {
  return { uid: identity.uid, id, gacha_type, gacha_id: "2005", item_id: "20000", time: "2025-07-15 12:00:09", ...fields };
}

function archive(records: StarRailUigfRow[], timezone = 8): StarRailUigfArchive {
  return { uid: identity.uid, timezone, lang: "zh-cn", records };
}

async function fixture(run: (paths: { readonly workspace: string; readonly legacy: string; readonly backup: string;
  readonly managed: string; readonly managedFile: string }, store: ReturnType<typeof createStarRailGachaRecordArchive>) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "lotus-starrail-gacha-rows-"));
  const directory = join(workspace, "starRailGachaRows");
  const legacyDirectory = join(workspace, "srJson");
  const legacy = join(legacyDirectory, identity.qq, identity.uid);
  const backup = join(`${legacyDirectory}.backup`, identity.qq, identity.uid);
  const managed = join(directory, identity.qq);
  try {
    await run({ workspace, legacy, backup, managed, managedFile: join(managed, `${identity.uid}.json`) },
      createStarRailGachaRecordArchive({ directory, legacyDirectory }, lockFile));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function writePool(directory: string, pool: StarRailUigfPool, records: readonly unknown[]) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${pool}.json`);
  await writeFile(file, `${JSON.stringify(records, null, "\t")}\n`);
  return file;
}

test("从旧 QQ/UID 目录只读六池逐抽记录，按真 ID 排序并优先使用现存旧档", () => fixture(async (paths, store) => {
  expect(await store.read(identity, options)).toEqual({ status: "unavailable", reason: "missing" });
  const records = pools.map((pool, index) => draw(`177427520000000000${index + 1}`, pool));
  const files = await Promise.all(records.map((row) => writePool(paths.legacy, row.gacha_type, [{ ...row, lang: "zh-cn" }])));
  await writePool(paths.backup, "11", [draw("1774275200000000009")]);
  const previous = await Promise.all(files.map((file) => readFile(file)));
  expect(await store.read(identity, options)).toEqual({ status: "available", source: "legacy", archive: archive(records) });
  expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(previous);
  expect(await Bun.file(paths.managedFile).exists()).toBe(false);
}));

test("Lotus 镜像和旧备份缺失分别报告，真实备份在冷启动时参与合并", () => fixture(async (paths, store) => {
  const { gacha_id: _gachaId, item_id: _itemId, ...fiveStarMirror } = draw("1774275200000000001", "11", {
    name: "镜像的五星", item_type: "角色", rank_type: "5",
  });
  const old = await writePool(paths.legacy, "11", [fiveStarMirror]);
  expect(await store.read(identity, options)).toEqual({ status: "unavailable", reason: "mirror" });
  const oldDraw = draw("1774275200000000001", "11", { name: "真实的五星" });
  const cold = await writePool(paths.backup, "11", [{ ...oldDraw, lang: "zh-cn" }]);
  const previous = await Promise.all([old, cold].map((file) => readFile(file)));
  expect(await store.read(identity, options)).toEqual({ status: "available", source: "backup", archive: archive([oldDraw]) });

  const share = draw(oldDraw.id, "11", { time: "2025-07-15 09:30:09", rank_type: "5" });
  const extension = draw("1774275200000000011", "22", { time: share.time });
  const merged = await store.merge(identity, archive([share, share, extension], 5.5), unchanged, options);
  expect(merged).toMatchObject({ received: 2, added: 1, total: 2 });
  expect(merged.pools.find(({ pool }) => pool === "11")).toEqual({ pool: "11", received: 1, added: 0, total: 1 });
  expect(merged.pools.find(({ pool }) => pool === "22")).toEqual({ pool: "22", received: 1, added: 1, total: 1 });
  expect(merged.archive).toEqual(archive([{ ...oldDraw, rank_type: "5" }, { ...extension, time: oldDraw.time }]));
  expect(await store.read(identity, options)).toEqual({ status: "available", source: "managed", archive: merged.archive });
  expect(await Promise.all([old, cold].map((file) => readFile(file)))).toEqual(previous);
}));

test("并发合并由真实档案锁串行，重复不改字节或 inode，旧 UID 失效和冲突保留原档", () => fixture(async (paths, store) => {
  const first = draw("1774275200000000011");
  const second = draw("1774275200000000012");
  const writes = await Promise.all([first, second].map((row) => store.merge(identity, archive([row]), unchanged, options)));
  expect(writes.map(({ added }) => added)).toEqual([1, 1]);
  expect(writes.map(({ total }) => total).sort()).toEqual([1, 2]);
  const original = await readFile(paths.managedFile);
  const originalStat = await lstat(paths.managedFile);
  const repeated = await store.merge(identity, archive([second, first, second]), unchanged, options);
  expect(repeated).toMatchObject({ received: 2, added: 0, total: 2 });
  expect((await lstat(paths.managedFile)).ino).toBe(originalStat.ino);
  await expect(store.merge(identity, archive([{ ...first, item_id: "20001" }]), unchanged, options))
    .rejects.toMatchObject({ code: "conflict" });

  const third = draw("1774275200000000013");
  let verifications = 0;
  await expect(store.merge(identity, archive([third]), async () => {
    if (++verifications === 3) throw new Error("档案 UID 已切换");
  }, options)).rejects.toThrow("档案 UID 已切换");
  expect(await readFile(paths.managedFile)).toEqual(original);
}));

test("卡池、角色或路径不匹配视为损坏，大小和非普通文件在读取前拒绝", () => fixture(async (paths, store) => {
  const original = await writePool(paths.legacy, "11", [draw("1774275200000000011", "12")]);
  await writePool(paths.backup, "11", [draw("1774275200000000022")]);
  await expect(store.read(identity, options)).rejects.toMatchObject({ code: "corrupt", message: expect.stringContaining("卡池编号") });
  await writePool(paths.legacy, "11", [draw("1774275200000000011", "11", { uid: "100000003" })]);
  await expect(store.read(identity, options)).rejects.toMatchObject({ code: "corrupt", message: expect.stringContaining("其他 UID") });
  await truncate(original, 16 * 1024 * 1024 + 1);
  await expect(store.read(identity, options)).rejects.toMatchObject({ code: "corrupt", message: expect.stringContaining("大小") });
  await rm(original);
  await symlink(join(paths.backup, "11.json"), original);
  await expect(store.read(identity, options)).rejects.toMatchObject({ code: "corrupt", message: expect.stringContaining("普通 JSON") });
  await rm(paths.legacy, { recursive: true });
  await symlink(paths.backup, paths.legacy, "dir");
  await expect(store.read(identity, options)).rejects.toMatchObject({ code: "corrupt", message: expect.stringContaining("实际目录") });
  await expect(store.read({ ...identity, qq: "../42" }, options)).rejects.toThrow("QQ 或 UID 无效");
}));

test("损坏的托管档案不从旧备份悄悄取代", () => fixture(async (paths, store) => {
  const valid = draw("1774275200000000011");
  await writePool(paths.backup, "11", [valid]);
  await mkdir(paths.managed, { recursive: true });
  await writeFile(paths.managedFile, "null\n");
  await expect(store.read(identity, options)).rejects.toMatchObject({ code: "corrupt" });
  await expect(store.merge(identity, archive([valid]), unchanged, options)).rejects.toThrow();
  expect(await readFile(paths.managedFile, "utf8")).toBe("null\n");
  await writeFile(paths.managedFile, JSON.stringify({ version: 1, qq: "43", ...archive([valid]) }));
  await expect(store.read(identity, options)).rejects.toMatchObject({ code: "corrupt", message: expect.stringContaining("QQ、UID") });
}));
