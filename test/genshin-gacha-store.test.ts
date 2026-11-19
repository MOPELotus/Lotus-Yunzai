import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { genshinGachaPools, type GenshinGachaPool, type GenshinGachaRow } from "../packages/hoyo-client/genshin-gacha.ts";
import type { GenshinGachaSnapshot } from "../plugins/genshin/gacha-history.ts";
import { createGenshinGachaHistoryStore } from "../plugins/genshin/gacha-store.ts";

const identity = { qq: "42", uid: "512345678" };
const region = "cn_qd01";
const journalName = ".lotus-genshin-gacha-journal.json";
const lockName = ".lotus-genshin-gacha.sqlite";
const fixtureStage = ".lotus-genshin-gacha-write-abcdef";
const noChange = async () => {};

function recorded(id: string, gacha_type: GenshinGachaRow["gacha_type"], extra: object = {}): GenshinGachaRow {
  return { id, uid: identity.uid, gacha_type, ...extra };
}

function latest(pools: Partial<Record<GenshinGachaPool, GenshinGachaRow[]>>): GenshinGachaSnapshot {
  return { uid: identity.uid, region, pools: genshinGachaPools.map((pool) => ({ ...pool, records: pools[pool.type] ?? [] })) };
}

function json(rows: unknown[]): string {
  return `${JSON.stringify(rows, null, "\t")}\n`;
}

async function fixture(run: (root: string, role: string, store: ReturnType<typeof createGenshinGachaHistoryStore>) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "lotus-genshin-history-store-"));
  const root = join(workspace, "data", "gachaJson");
  const role = join(root, identity.qq, identity.uid);
  try {
    await run(root, role, createGenshinGachaHistoryStore(root, lockFile));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function writePool(role: string, type: GenshinGachaPool, rows: unknown[], mode = 0o600) {
  const path = join(role, `${type}.json`);
  await writeFile(path, json(rows), { mode });
  return path;
}

test("按 QQ 和 UID 保存旧四池数组，保留无变化文件和原权限，并串行合并", () => fixture(async (root, role, store) => {
  expect(await store.read(identity.qq, identity.uid)).toEqual({});
  expect(await Bun.file(root).exists()).toBe(false);
  await mkdir(role, { recursive: true });
  const old = recorded("9223372036854775807", "400", { legacy: true });
  const character = await writePool(role, 301, [old]);
  await chmod(character, 0o640);
  const stable = await writePool(role, 500, [recorded("30", "500")]);
  const stableInode = (await lstat(stable)).ino;
  const first = recorded("17358538100000019221", "301");
  const second = recorded("17358538100000019222", "301");
  const weapon = recorded("1000", "302");
  await Promise.all([
    store.merge(identity, latest({ 301: [first], 302: [weapon] }), noChange),
    store.merge(identity, latest({ 301: [second] }), noChange),
  ]);
  const expected = { 301: [second, first, old], 302: [weapon], 500: [recorded("30", "500")] };
  expect(await store.read(identity.qq, identity.uid)).toEqual(expected);
  expect(JSON.parse(await readFile(character, "utf8"))).toEqual(expected[301]);
  expect((await lstat(character)).mode & 0o777).toBe(0o640);
  expect((await lstat(stable)).ino).toBe(stableInode);
  expect((await lstat(join(role, "302.json"))).mode & 0o777).toBe(0o600);
  expect((await readdir(role)).sort()).toEqual([lockName, "301.json", "302.json", "500.json"]);
  expect(await store.read("43", identity.uid)).toEqual({});
}));

test("首次保存创建兼容目录，只建立有记录的卡池文件", () => fixture(async (_root, role, store) => {
  const entry = recorded("17358538100000019222", "200");
  await store.merge(identity, latest({ 200: [entry] }), noChange);
  expect((await readdir(role)).sort()).toEqual([lockName, "200.json"]);
  expect(await store.read(identity.qq, identity.uid)).toEqual({ 200: [entry] });
}));

test("新手池只读旧 100.json，四池更新和其他用户不接触这份档案", () => fixture(async (_root, role, store) => {
  expect(await store.readBeginner(identity.qq, identity.uid)).toEqual([]);
  await mkdir(role, { recursive: true });
  const newcomer = { id: "9223372036854775807", uid: identity.uid, gacha_type: "100", name: "诺艾尔" };
  const path = join(role, "100.json");
  await writeFile(path, json([newcomer]));
  const original = await lstat(path);
  expect(await store.readBeginner(identity.qq, identity.uid)).toEqual([newcomer]);
  expect(await store.readBeginner("43", identity.uid)).toEqual([]);
  expect((await readdir(role)).sort()).toEqual(["100.json"]);
  const regular = recorded("30", "200");
  await store.merge(identity, latest({ 200: [regular] }), noChange);
  expect(await store.read(identity.qq, identity.uid)).toEqual({ 200: [regular] });
  expect(await readFile(path, "utf8")).toBe(json([newcomer]));
  expect((await lstat(path)).ino).toBe(original.ino);
}));

test("发布日志前再次检查档案和所有旧池指纹，外部改写原样保留", () => fixture(async (_root, role, store) => {
  await mkdir(role, { recursive: true });
  const character = await writePool(role, 301, [recorded("10", "301")]);
  const original = await readFile(character);
  const weapon = await writePool(role, 302, [recorded("11", "302")]);
  const incoming = latest({ 301: [recorded("20", "301")] });
  let checks = 0;
  await expect(store.merge(identity, incoming, async () => {
    if (++checks === 3) throw new Error("档案已换绑。");
  })).rejects.toThrow("档案已换绑");
  expect(await readFile(character)).toEqual(original);
  expect(await Bun.file(join(role, journalName)).exists()).toBe(false);
  const outside = [recorded("99", "302", { external: true })];
  checks = 0;
  await expect(store.merge(identity, incoming, async () => {
    if (++checks !== 3) return;
    const replacement = join(role, "external.json");
    await writeFile(replacement, json(outside));
    await rename(replacement, weapon);
  })).rejects.toThrow("其他进程改写");
  expect(await readFile(character)).toEqual(original);
  expect(JSON.parse(await readFile(weapon, "utf8"))).toEqual(outside);
  expect((await readdir(role)).sort()).toEqual([lockName, "301.json", "302.json"]);
}));

async function seedPartial(role: string, alreadyApplied: boolean) {
  const old = [recorded("10", "301")];
  const target = [recorded("20", "301"), ...old];
  const weapon = [recorded("15", "302")];
  const oldFile = await writePool(role, 301, old);
  const info = await lstat(oldFile, { bigint: true });
  const owner = { uid: Number(info.uid), gid: Number(info.gid), mode: Number(info.mode & 0o777n) };
  const stamp = [info.dev, info.ino, info.size, info.ctimeNs, info.mtimeNs, info.mode, info.uid, info.gid].join(":");
  const hash = (rows: unknown[]) => createHash("sha256").update(json(rows)).digest("hex");
  const staging = join(role, fixtureStage);
  await mkdir(staging);
  await writePool(staging, 301, target);
  await writePool(staging, 302, weapon);
  await writeFile(join(role, journalName), JSON.stringify({ ...identity, version: 1, staging: fixtureStage, entries: [
    { type: 301, before: { stamp, sha256: hash(old) }, after: hash(target), owner },
    { type: 302, before: null, after: hash(weapon), owner },
  ] }), { mode: 0o600 });
  if (alreadyApplied) await writePool(role, 301, target);
  return { old, target, weapon };
}

test("读路径幂等回放已提交而中断的多池日志", () => fixture(async (_root, role, store) => {
  await mkdir(role, { recursive: true });
  const expected = await seedPartial(role, true);
  const published = await lstat(join(role, "301.json"));
  expect(await store.read(identity.qq, identity.uid)).toEqual({ 301: expected.target, 302: expected.weapon });
  expect((await lstat(join(role, "301.json"))).ino).toBe(published.ino);
  expect((await readdir(role)).sort()).toEqual([lockName, "301.json", "302.json"]);
  expect(await store.read(identity.qq, identity.uid)).toEqual({ 301: expected.target, 302: expected.weapon });
}));

test("持有固定锁的写进程被硬终止后，下一次读取恢复剩余文件", () => fixture(async (_root, role, store) => {
  await mkdir(role, { recursive: true });
  const expected = await seedPartial(role, false);
  const child = Bun.spawn([process.execPath, "--eval", `
    import { copyFileSync, renameSync } from "node:fs";
    import { join } from "node:path";
    import { lockFile } from ${JSON.stringify(join(import.meta.dir, "../lib/file-lock.ts"))};
    const role = process.argv[1];
    const lock = await lockFile(join(role, ${JSON.stringify(lockName)}), "中断夹具");
    const temporary = join(role, "part.json");
    copyFileSync(join(role, ${JSON.stringify(fixtureStage)}, "301.json"), temporary);
    renameSync(temporary, join(role, "301.json"));
    console.log("partial");
    await Bun.sleep(30_000);
    lock.close();
  `, role], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const output = await Promise.race([
    reader.read(), Bun.sleep(2_000).then(() => { throw new Error("中断夹具启动超时。"); }),
  ]).finally(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
  });
  expect(new TextDecoder().decode(output.value)).toBe("partial\n");
  expect(child.signalCode).toBe("SIGKILL");
  expect(await store.read(identity.qq, identity.uid)).toEqual({ 301: expected.target, 302: expected.weapon });
  expect(await Bun.file(join(role, journalName)).exists()).toBe(false);
}));

test("已提交日志遇到外部新建目标文件，回放保留现有内容和日志", () => fixture(async (_root, role, store) => {
  await mkdir(role, { recursive: true });
  const expected = await seedPartial(role, false);
  const outside = [recorded("99", "302", { external: true })];
  await writePool(role, 302, outside);
  await expect(store.read(identity.qq, identity.uid)).rejects.toThrow("其他进程改写");
  expect(await Bun.file(join(role, "301.json")).json()).toEqual(expected.old);
  expect(await Bun.file(join(role, "302.json")).json()).toEqual(outside);
  expect(await Bun.file(join(role, journalName)).exists()).toBe(true);
  expect(await Bun.file(join(role, fixtureStage, "302.json")).json()).toEqual(expected.weapon);
}));

test("拒绝越界目录及损坏回放数据，保留旧文件", () => fixture(async (root, role, store) => {
  await mkdir(root, { recursive: true });
  await symlink(root, join(root, "43"), "dir");
  await expect(store.read("43", identity.uid)).rejects.toThrow("实体目录");
  await mkdir(role, { recursive: true });
  const expected = await seedPartial(role, false);
  await writePool(join(role, fixtureStage), 302, [recorded("999", "302")]);
  await expect(store.read(identity.qq, identity.uid)).rejects.toThrow("提交校验值不一致");
  expect(await Bun.file(join(role, "301.json")).json()).toEqual(expected.old);
  expect(await Bun.file(join(role, "302.json")).exists()).toBe(false);
  expect(await Bun.file(join(role, journalName)).exists()).toBe(true);
}));
