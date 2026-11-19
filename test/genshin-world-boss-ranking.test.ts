import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenshinWorldBossSnapshot } from "@lotus-yunzai/hoyo-client";
import { lockFile } from "../lib/file-lock.ts";
import { createGenshinWorldBossRanking } from "../plugins/genshin/world-boss-ranking.ts";

const owner = { qq: "42", uid: "123456789", region: "cn_gf01" };
const unchanged = async () => {};
type Store = ReturnType<typeof createGenshinWorldBossRanking>;

function snapshot(identity: { uid: string; region: string }, rows: [string, number][]): GenshinWorldBossSnapshot {
  return { uid: identity.uid, region: identity.region, status: "available",
    groups: [{ name: "不写盘的地区", bosses: rows.map(([name, killCount]) => ({ name, killCount })) }] };
}

async function fixture(run: (store: Store, dir: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "lotus-world-boss-rank-"));
  const directory = join(workspace, "world-boss");
  try {
    await run(createGenshinWorldBossRanking(directory, lockFile), directory);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("较早的并发结果、相同开始时间和未提供计数保留新档及文件原样", () => fixture(async (store, directory) => {
  const paused = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const earlier = store.record(owner, snapshot(owner, [["急冻树", 999]]), 100, async () => {
    ready.resolve();
    await paused.promise;
  });
  await ready.promise;
  try {
    expect(await store.record(owner, snapshot(owner, [["急冻树", 30], ["无相之岩", 0]]), 101, unchanged)).toBe(true);
  } finally {
    paused.resolve();
  }
  expect(await earlier).toBe(false);
  const path = join(directory, owner.qq, `${owner.uid}.json`);
  const saved = await readFile(path);
  const info = await lstat(path);
  expect(saved.toString()).not.toContain("不写盘的地区");
  expect(info.mode & 0o777).toBe(0o600);
  expect(await store.record(owner, { ...snapshot(owner, []), status: "unavailable" }, 103, unchanged)).toBe(false);
  expect(await store.record(owner, snapshot(owner, [["急冻树", 40]]), 101, unchanged)).toBe(false);
  expect(await readFile(path)).toEqual(saved);
  expect((await lstat(path)).ino).toBe(info.ino);
  expect(await store.rank()).toEqual([
    { name: "急冻树", killCount: 30, uid: owner.uid }, { name: "无相之岩", killCount: 0, uid: owner.uid },
  ]);
}));

test("跨 QQ 同 UID 只取最新，逐 BOSS 最高数、同分最小数字 UID 和旧键顺序", () => fixture(async (store) => {
  const larger = { qq: "9", uid: "523456789", region: "cn_qd01" };
  const duplicate = { ...owner, qq: "7" };
  const tiedSameUid = { ...owner, qq: "8" };
  await store.record(larger, snapshot(larger, [["急冻树", 15], ["无相之岩", 32], ["古岩龙蜥", 7]]), 50, unchanged);
  await store.record(owner, snapshot(owner, [["过时记录", 999], ["急冻树", 25]]), 60, unchanged);
  await store.record(tiedSameUid, snapshot(owner, [["同时间较大 QQ 的记录", 999]]), 61, unchanged);
  await store.record(duplicate, snapshot(owner, [
    ["无相之岩", 10], ["急冻树", 15], ["急冻树", 0], ["无相之风", 0],
  ]), 61, unchanged);
  expect(await store.rank()).toEqual([
    { name: "无相之岩", killCount: 32, uid: larger.uid },
    { name: "急冻树", killCount: 15, uid: owner.uid },
    { name: "无相之风", killCount: 0, uid: owner.uid },
    { name: "古岩龙蜥", killCount: 7, uid: larger.uid },
  ]);
  expect(await store.record(duplicate, snapshot(owner, []), 62, unchanged)).toBe(true);
  expect(await store.rank()).toEqual([
    { name: "急冻树", killCount: 15, uid: larger.uid },
    { name: "无相之岩", killCount: 32, uid: larger.uid },
    { name: "古岩龙蜥", killCount: 7, uid: larger.uid },
  ]);
}));

test("榜单不读旧全局表和符号链接，身份不一致或变更不能写入摘要", () => fixture(async (store, directory) => {
  expect(await store.rank()).toEqual([]);
  await mkdir(directory, { recursive: true });
  const old = join(directory, "GenshinWorldBossKillNumberData.json");
  await writeFile(old, "legacy fixture does not need to be valid JSON");
  await symlink("/unavailable-fixture", join(directory, "43"), "dir");
  await mkdir(join(directory, "44"));
  await symlink(old, join(directory, "44", `${owner.uid}.json`));
  expect(await store.rank()).toEqual([]);
  await expect(store.record(owner, snapshot({ ...owner, uid: "223456789" }, [["急冻树", 0]]), 100, unchanged))
    .rejects.toThrow("格式");
  await expect(store.record({ ...owner, region: "cn_qd01" }, snapshot({ ...owner, region: "cn_qd01" }, []), 100, unchanged))
    .rejects.toThrow("格式");
  let verifies = 0;
  await expect(store.record(owner, snapshot(owner, [["急冻树", 12]]), 101, async () => {
    if (++verifies === 3) throw new Error("档案已更改");
  })).rejects.toThrow("档案已更改");
  expect(verifies).toBe(3);
  expect(await store.rank()).toEqual([]);
  expect(await readFile(old, "utf8")).toBe("legacy fixture does not need to be valid JSON");
}));
