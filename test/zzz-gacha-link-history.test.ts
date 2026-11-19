import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zzzTuningPools } from "@lotus-yunzai/hoyo-client";
import { lockFile } from "../lib/file-lock";
import { createZzzLinkHistory, mergeZzzLegacyWithLinked, type ZzzLinkedGachaSnapshot } from "../plugins/zzz/gacha-link-history";
import type { ZzzLegacyGachaDraw, ZzzLegacyGachaPool } from "../plugins/zzz/gacha-legacy";

const role = { qq: "42", uid: "1300000002", region: "prod_gf_jp" };
const noChange = async () => {};
const weapon = "GACHA_TYPE_WEAPON_UP";
const character = "GACHA_TYPE_CHARACTER_UP";
const ids = ["9223372036854775805", "9223372036854775806", "9223372036854775807"];
type TestStore = ReturnType<typeof createZzzLinkHistory>;
type Pool = ZzzLegacyGachaPool["type"];

function draw(id: string, extra: Partial<ZzzLegacyGachaDraw> = {}): ZzzLegacyGachaDraw {
  return { id, itemId: "14119", gachaId: "55122", rank: "4", time: "2026-07-13 09:00:00",
    name: "深海访客", lang: "zh-cn", itemType: "音擎", count: 1, ...extra };
}

function snapshot(entries: Partial<Record<Pool, readonly ZzzLegacyGachaDraw[]>>, timezone = 8): ZzzLinkedGachaSnapshot {
  return {
    uid: role.uid, region: role.region, gameBiz: "nap_global", timezone,
    pools: Object.entries(zzzTuningPools).map(([key, { name, id }]) => {
      const type = key as Pool;
      return { type, name, gachaType: String(id) as ZzzLegacyGachaPool["gachaType"], records: entries[type] ?? [] };
    }),
  };
}

async function fixture(run: (store: TestStore, file: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-zzz-linked-history-"));
  try {
    await run(createZzzLinkHistory(directory, lockFile), join(directory, role.qq, `${role.uid}.json`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("串行提交不同链接窗口，保留旧长编号和六池，完全重复时保持 JSON 字节及 inode", () => fixture(async (store, file) => {
  expect(await store.read(role.qq, role)).toBeUndefined();
  const first = {
    ...snapshot({ [weapon]: [draw(ids[0]!, { icon: "https://fixture.invalid/unused" })] }),
    authkey: "synthetic-key",
  };
  await store.merge(role, first, noChange);
  await Promise.all([
    store.merge(role, snapshot({ [weapon]: [draw(ids[1]!), draw(ids[1]!)] }), noChange),
    store.merge(role, snapshot({ [weapon]: [draw(ids[2]!)] }), noChange),
  ]);
  const saved = await store.read(role.qq, role);
  expect(saved?.pools).toHaveLength(6);
  expect(saved?.pools.find(({ type }) => type === weapon)?.records.map(({ id }) => id)).toEqual([...ids].reverse());
  expect(await store.read("43", role)).toBeUndefined();
  const previous = await readFile(file);
  expect(previous.toString()).not.toContain("synthetic-key");
  expect(previous.toString()).not.toContain("fixture.invalid");
  const inode = (await lstat(file)).ino;
  const repeat = await store.merge(role, snapshot({ [weapon]: [draw(ids[2]!)] }), noChange);
  expect(repeat.addedTotal).toBe(0);
  expect(Object.values(repeat.added)).toEqual([0, 0, 0, 0, 0, 0]);
  expect(repeat.stats).toEqual(saved!);
  expect(await readFile(file)).toEqual(previous);
  expect((await lstat(file)).ino).toBe(inode);
}));

test("区服、时区、同号记录或角色核对冲突会保留原归档", () => fixture(async (store, file) => {
  const [original, fresh] = [draw(ids[0]!), draw(ids[1]!)];
  await store.merge(role, snapshot({ [weapon]: [original] }), noChange);
  const saved = await readFile(file);
  const inode = (await lstat(file)).ino;
  await expect(store.read(role.qq, { ...role, region: "prod_gf_eu" })).rejects.toThrow("地区");
  await expect(store.merge(role, snapshot({ [weapon]: [fresh] }, 9), noChange)).rejects.toThrow("时区");
  await expect(store.merge(role, snapshot({ [weapon]: [{ ...original, itemId: "14120" }, fresh] }), noChange))
    .rejects.toThrow("重复记录");
  await expect(store.merge(role, snapshot({ [character]: [original] }), noChange)).rejects.toThrow("所属频段");
  let checks = 0;
  await expect(store.merge(role, snapshot({ [weapon]: [fresh] }), async () => {
    if (++checks === 3) throw new Error("档案已变更");
  })).rejects.toThrow("档案已变更");
  expect(checks).toBe(3);
  expect(await readFile(file)).toEqual(saved);
  expect((await lstat(file)).ino).toBe(inode);
}));

test("旧档视图联合保留旧独有墙钟时间，兼容同号 Cookie 项的活动缺省", () => {
  const oldOnly = draw(ids[0]!, { time: "2026-07-13 01:00:00", gachaId: "0" });
  const oldOverlap = draw(ids[1]!, { time: "2026-07-13 02:00:00", gachaId: "0", lang: "en-us", name: "Deep Sea Visitor" });
  const linked = snapshot({ [weapon]: [draw(ids[1]!), draw(ids[2]!)] });
  const { uid, pools } = snapshot({ [weapon]: [oldOverlap, oldOnly] });
  const legacy = { uid, pools };
  const merged = mergeZzzLegacyWithLinked(legacy, linked);
  expect(merged).not.toHaveProperty("timezone");
  expect(merged?.pools.find(({ type }) => type === weapon)?.records).toEqual([draw(ids[2]!), draw(ids[1]!), oldOnly]);
  expect(legacy.pools.find(({ type }) => type === weapon)?.records[0]).toBe(oldOverlap);
  expect(() => mergeZzzLegacyWithLinked({ ...legacy, uid: "1300000003" }, linked)).toThrow("UID");
  expect(() => mergeZzzLegacyWithLinked(legacy, snapshot({ [character]: [draw(ids[1]!)] }))).toThrow("所属频段");
});
