import { expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zzzTuningPools, type ZzzTuningSnapshot } from "../packages/hoyo-client/zzz-tuning.ts";
import { createStarRailGachaHistoryStore } from "../plugins/starrail/gacha-store.ts";
import { readZzzLegacyGachaSources } from "../plugins/zzz/gacha-legacy.ts";
import { createZzzTuningSync } from "../plugins/zzz/tuning-sync.ts";
import { stageLegacySharedGameHistory } from "../lib/migration-shared-game-history.ts";

const qq = "9223372036854775807";
const starRailUid = "100000041";
const zzzUid = "10000042";
const region = "prod_gf_cn";
const firstId = "9223372036854775806";
const secondId = "9223372036854775807";
const firstPlugin = "Lotus-Plugin";
const secondPlugin = "Lotus-ReFactor";
const migrationRoot = "data/legacy-game-history";
const lockNeverTaken = async (): Promise<never> => { throw new Error("只读验收不能获取写锁"); };

const starRail = {
  version: 1, qq, uid: starRailUid, region, profileId: 7, source: "mihoyo_star_rail_gacha_miniapp",
  pools: { GachaType_AvatarUp: { totalDraws: 31, pity: 6, fiveStars: [
    { id: firstId, uuid: "", item: { item_id: 1220 }, gacha_count: 25 },
  ] } },
};
const zzzDraw = {
  uid: zzzUid, id: firstId, gacha_id: "0", gacha_type: "2", item_id: "14101", count: "1",
  time: "2026-04-03 04:05:06", name: "测试角色", lang: "zh-cn", item_type: "代理人", rank_type: "4",
};

function zzzStats(profileId: number, updatedAt: string): ZzzTuningSnapshot {
  return {
    version: 1, uid: zzzUid, profileId, region, updatedAt, currentVersion: "1.0",
    totalDraws: 0, totalS: 0, inventory: { polychrome: 51 },
    pools: (Object.keys(zzzTuningPools) as (keyof typeof zzzTuningPools)[]).map(type => ({
      type, name: zzzTuningPools[type].name, totalDraws: 0, totalS: 0,
      upCount: null, averageUp: null, pity: null, guaranteedWithin: null, records: [], periods: [],
    })),
  };
}

async function fixture(run: (source: string, state: string) => Promise<void>) {
  const work = await mkdtemp(join(tmpdir(), "lotus-shared-game-history-"));
  try {
    const source = join(work, "old");
    const state = join(work, "stage");
    await mkdir(source, { mode: 0o700 });
    await mkdir(state, { mode: 0o700 });
    await run(source, state);
  } finally {
    await rm(work, { force: true, recursive: true });
  }
}

function oldFile(source: string, plugin: string, family: string, uid: string) {
  return join(source, "plugins", plugin, "data", family, qq, uid + ".json");
}

function stagedFile(state: string, plugin: string, family: string, uid: string) {
  return join(state, migrationRoot, plugin, family, qq, uid + ".json");
}

async function writeJson(file: string, document: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const bytes = JSON.stringify(document, null, 2) + "\r\n";
  await writeFile(file, bytes);
  return bytes;
}

test("迁移退役跃迁、调频逐抽和官方统计至独立只读回退，保留原文件及长编号", () => fixture(async (source, state) => {
  const originals = [
    [firstPlugin, "starRailGachaJson", starRailUid, starRail],
    [secondPlugin, "starRailGachaJson", starRailUid, { ...starRail }],
    [firstPlugin, "zzzGachaJson", zzzUid, { "独家频段": [zzzDraw] }],
    [secondPlugin, "zzzGachaJson", zzzUid, { "独家频段": [
      { ...zzzDraw, id: secondId, item_id: "14102" }, { ...zzzDraw, gacha_id: "501" },
    ] }],
    [firstPlugin, "zzzTuningStats", zzzUid, zzzStats(3, "2026-03-01T00:00:00.000Z")],
    [secondPlugin, "zzzTuningStats", zzzUid, zzzStats(5, "2026-03-03T00:00:00.000Z")],
  ] as const;
  const bytes = await Promise.all(originals.map(([plugin, family, uid, data]) =>
    writeJson(oldFile(source, plugin, family, uid), data)));
  const ignored = join(source, "plugins", firstPlugin, "data");
  await writeJson(join(ignored, "auth.json"), { authkey: "never-read-this-fixture" });
  await writeJson(join(ignored, "zzzGachaJson", qq, "historic-note.json"), { cookie: "not-a-history-file" });

  const summary = await stageLegacySharedGameHistory(source, state);
  expect(summary).toEqual(originals.map(([plugin, family], index) => ({
    path: join(migrationRoot, plugin, family), files: 1, bytes: Buffer.byteLength(bytes[index]!),
  })).sort((a, b) => a.path.localeCompare(b.path, "en")));
  for (const [i, [plugin, family, uid]] of originals.entries()) {
    const file = stagedFile(state, plugin, family, uid);
    expect(await readFile(file, "utf8")).toBe(bytes[i]!);
    expect(await readFile(oldFile(source, plugin, family, uid), "utf8")).toBe(bytes[i]!);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(file))).mode & 0o777).toBe(0o700);
  }
  expect(JSON.stringify(summary)).not.toContain(qq);
  expect(JSON.stringify(summary)).not.toContain(zzzUid);
  expect(await Bun.file(join(state, "data/zzzGachaJson", qq, zzzUid + ".json")).exists()).toBe(false);
  expect(await Bun.file(join(state, "data/zzzTuningStats", qq, zzzUid + ".json")).exists()).toBe(false);
  const retired = (family: string) => [firstPlugin, secondPlugin].map(plugin => join(state, migrationRoot, plugin, family));
  const starArchive = createStarRailGachaHistoryStore(join(state, "data/starRailGachaJson"), lockNeverTaken, retired("starRailGachaJson"));
  // The host consults the active summary, then srJson true rows, and only then the read-only old summary.
  expect(await starArchive.read(qq, starRailUid)).toBeNull();
  expect(await starArchive.readLegacy("43", starRailUid)).toBeNull();
  expect(await starArchive.readLegacy(qq, starRailUid)).toEqual(starRail);
  const exact = await readZzzLegacyGachaSources(join(state, "data/zzzGachaJson"), retired("zzzGachaJson"), qq, zzzUid);
  expect(exact?.pools.flatMap(pool => pool.records.map(({ id, gachaId }) => [id, gachaId]))).toEqual([
    [secondId, "0"], [firstId, "501"],
  ]);
  expect(await readZzzLegacyGachaSources(join(state, "data/zzzGachaJson"), retired("zzzGachaJson"), "43", zzzUid)).toBeUndefined();
  const tuning = createZzzTuningSync({ requestSelectedContext: lockNeverTaken }, { fetchZzzTuning: lockNeverTaken },
    join(state, "data/zzzTuningStats"), lockNeverTaken, retired("zzzTuningStats"));
  expect(await tuning.read(qq, { uid: zzzUid, region })).toEqual(zzzStats(5, "2026-03-03T00:00:00.000Z"));
  expect(await tuning.read("43", { uid: zzzUid, region })).toBeNull();
}));

test("迁移拒绝身份错配、含凭据的已识别旧历史及矛盾回退，同时仅返回脱敏错误", () => fixture(async (source, state) => {
  const otherState = async (name: string) => {
    const path = join(dirname(state), name);
    await mkdir(path, { mode: 0o700 });
    return path;
  };
  const first = oldFile(source, firstPlugin, "starRailGachaJson", starRailUid);
  await writeJson(first, { ...starRail, qq: "1111111" });
  await expect(stageLegacySharedGameHistory(source, state)).rejects.toThrow("与当前读档格式不兼容");
  const secret = "fixture-credentials-must-not-appear";
  await writeJson(first, { ...starRail, metadata: { authkey: secret } });
  const error = await stageLegacySharedGameHistory(source, await otherState("secret")).catch(error => error);
  expect(error.message).toContain("不宜迁移");
  expect(error.message).not.toContain(secret);
  expect(error.message).not.toContain(qq);
  await writeJson(first, starRail);
  await writeJson(oldFile(source, secondPlugin, "starRailGachaJson", starRailUid), { ...starRail, profileId: 8 });
  await expect(stageLegacySharedGameHistory(source, await otherState("conflict"))).rejects.toThrow("同档记录冲突");
}));

test("迁移拒绝相关路径的链接、非私有暂存或取消", () => fixture(async (source, state) => {
  const file = oldFile(source, firstPlugin, "starRailGachaJson", starRailUid);
  const external = join(dirname(source), "out.json");
  await writeJson(external, starRail);
  await mkdir(dirname(file), { recursive: true });
  await symlink(external, file);
  await expect(stageLegacySharedGameHistory(source, state)).rejects.toThrow("无硬链接的普通文件");
  await rm(file);
  await link(external, file);
  await expect(stageLegacySharedGameHistory(source, state)).rejects.toThrow("无硬链接的普通文件");
  await expect(stageLegacySharedGameHistory(source, source)).rejects.toThrow("独立的私有实体目录");
  const cancellation = new Error("synthetic abort");
  await expect(stageLegacySharedGameHistory(source, state, AbortSignal.abort(cancellation))).rejects.toThrow(cancellation.message);
}));
