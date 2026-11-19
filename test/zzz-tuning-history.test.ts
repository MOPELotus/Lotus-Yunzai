import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { createProfileStore } from "../packages/account/index.ts";
import { zzzTuningPools, type ZzzTuningSnapshot } from "../packages/hoyo-client/index.ts";
import { prepareZzzTuningUpdate, readZzzTuningHistory } from "../plugins/zzz/tuning-history.ts";
import { createZzzTuningSync } from "../plugins/zzz/tuning-sync.ts";

const uid = "123456789";
const region = "prod_gf_cn";
const identity = { uid, region, profileId: 2 } as const;
const earlier = "2026-11-18T01:00:00.000Z";
const later = "2026-11-19T01:00:00.000Z";
const weapon = "GACHA_TYPE_WEAPON_UP";
const bangboo = "GACHA_TYPE_BANGBOO";
const item = {
  itemId: "12001", name: "示例音擎", icon: "", rarity: "S", itemType: "WEAPON", isUp: true,
  upTag: "", count: 7, time: 1_725_000_000, sort: "2", version: "1.2",
};

function snapshot(updatedAt = earlier, profileId = 1, copies = 1): ZzzTuningSnapshot {
  const records = Array.from({ length: copies }, () => item);
  const types = Object.keys(zzzTuningPools) as (keyof typeof zzzTuningPools)[];
  return {
    version: 1, uid, region, profileId, updatedAt, currentVersion: "1.2",
    totalDraws: copies * 7, totalS: copies, inventory: { monochrome: 0, encryptedMasterTape: 4 },
    pools: types.map((type) => ({
      type, name: zzzTuningPools[type].name, totalDraws: type === weapon ? copies * 7 : type === bangboo ? 5 : 0,
      totalS: type === weapon ? copies : 0,
      upCount: type === weapon ? copies : null, averageUp: type === weapon ? 7 : null,
      pity: type === weapon ? 0 : null, guaranteedWithin: null, records: type === weapon ? records : [],
      periods: type === weapon ? [{
        version: "1.2", status: "", startAt: null, endAt: null, leftStartAt: null, leftEndAt: null, firstUp: item,
        items: [{ ...item, itemId: "12002", rarity: "A", count: null, time: null }], records,
      }] : [],
    })),
  };
}

test("绝区零同步沿用旧文件，较迟完成的读和中途换绑均保留已有快照", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-zzz-tuning-history-"));
  const profileFile = join(root, "42-2.yaml");
  const directory = join(root, "zzzTuningStats");
  const file = join(directory, "42", `${uid}.json`);
  const profile = `
user: { qq: "42" }
profile: { id: 2 }
account:
  cookie: cookie_token=test-login
  stoken: fixture-stoken
  stuid: "42"
  game_roles: { zzz: [{ uid: "${uid}", region: ${region}, game_biz: nap_cn }] }
  current_uid: { zzz: "${uid}" }
`;
  try {
    await mkdir(join(directory, "42"), { recursive: true });
    await Promise.all([writeFile(profileFile, profile), writeFile(file, JSON.stringify(snapshot()))]);
    const profiles = createProfileStore(root);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let reads = 0;
    const service = createZzzTuningSync(profiles, {
      async fetchZzzTuning(context) {
        const sequence = ++reads;
        if (sequence === 1) {
          started.resolve();
          await finish.promise;
        }
        if (sequence === 3) await writeFile(profileFile, profile.replaceAll(uid, "123456780"));
        const data = sequence === 2 ? snapshot(later, 2, 2) : snapshot("2026-11-20T01:00:00.000Z", 2, 3);
        return { ...data, revision: context.revision, refreshedCookie: sequence === 2 };
      },
    }, directory, lockFile);

    const pending = service.sync("42", 2);
    await started.promise;
    try {
      const result = await service.sync("42", 2);
      expect(result.refreshedCookie).toBe(true);
      expect(result.pools.find(({ type }) => type === weapon)?.added).toBe(1);
    } finally {
      finish.resolve();
    }
    await expect(pending).rejects.toThrow("绝区零调频历史已更新");
    const saved = await readFile(file, "utf8");
    expect(JSON.parse(saved)).toEqual(snapshot(later, 2, 2));
    await expect(service.sync("42", 2)).rejects.toMatchObject({ code: "changed" });
    expect(await readFile(file, "utf8")).toBe(saved);
    expect(await service.read("42", identity)).toEqual(snapshot(later, 2, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads legacy v1 stats with their stored profile id and retains official per-period S records and inventory", () => {
  const old = JSON.parse(JSON.stringify(snapshot()));
  expect(readZzzTuningHistory(old, identity)).toEqual(snapshot());
  expect(readZzzTuningHistory(null, identity)).toBeNull();
  expect(readZzzTuningHistory(undefined, identity)).toBeNull();
  expect(() => readZzzTuningHistory({ ...old, version: 2 }, identity)).toThrow("格式版本");
  expect(() => readZzzTuningHistory({ ...old, uid: "123456780" }, identity)).toThrow("UID 或分区");
  expect(() => readZzzTuningHistory({ ...old, region: "prod_qd_cn" }, identity)).toThrow("UID 或分区");
  expect(() => readZzzTuningHistory({ ...old, profileId: 256 }, identity)).toThrow("档案编号");
});

test("replaces the whole validated snapshot, counts repeated S outcomes by occurrence, and omits request metadata", () => {
  const old = snapshot();
  const next = { ...snapshot(later, 2, 2), inventory: { boopon: 1 }, revision: "fixture-revision", refreshedCookie: true };
  const result = prepareZzzTuningUpdate(old, next, identity);
  expect(result).toMatchObject({ ok: true, source: "official_tuning_stats", gameBiz: "nap_cn", uid, region, profileId: 2 });
  expect(result.stats).toEqual({ ...snapshot(later, 2, 2), inventory: { boopon: 1 } });
  expect(result.stats).not.toHaveProperty("revision");
  expect(result.stats).not.toHaveProperty("refreshedCookie");
  expect(result.pools.find(({ type }) => type === weapon)).toMatchObject({ added: 1, total: 2, totalDraws: 14, pity: 0 });
  expect(result.pools.find(({ type }) => type === bangboo)).toMatchObject({ added: 0, total: 0, totalDraws: 5 });
  expect(prepareZzzTuningUpdate(result.stats, next, identity).pools.every(({ added }) => added === 0)).toBe(true);
  expect(old.profileId).toBe(1);
  expect(old.inventory).toEqual({ monochrome: 0, encryptedMasterTape: 4 });
});

test("accepts a newer fully reconciled correction and rejects writing a slower older complete request", () => {
  const old = snapshot(earlier, 1, 2);
  const corrected = snapshot(later, 2, 1);
  expect(prepareZzzTuningUpdate(old, corrected, identity).stats).toEqual(corrected);
  expect(() => prepareZzzTuningUpdate(corrected, { ...old, profileId: 2 }, identity)).toThrow("无法覆盖");
  expect(() => prepareZzzTuningUpdate(old, { ...corrected, updatedAt: "2026-02-31T01:00:00.000Z" }, identity)).toThrow("保存时间");
  expect(() => prepareZzzTuningUpdate(old, { ...corrected, profileId: 1 }, identity)).toThrow("当前档案编号");
});

test("rejects partial, corrupted, or foreign history instead of treating it as an empty local file", () => {
  const current = snapshot(later, 2);
  const old = snapshot();
  const [first, ...other] = current.pools;
  const replaceFirst = (replacement: unknown) => ({ ...current, pools: [replacement, ...other] });
  expect(() => prepareZzzTuningUpdate(old, null, identity)).toThrow("新数据");
  expect(() => prepareZzzTuningUpdate({}, current, identity)).toThrow("格式版本");
  expect(() => prepareZzzTuningUpdate(old, { ...current, pools: other }, identity)).toThrow("六个频段");
  expect(() => prepareZzzTuningUpdate(old, { ...current, totalDraws: 12 }, identity)).toThrow("全频段官方总账");
  expect(() => prepareZzzTuningUpdate(old, { ...current, pools: [first, first, ...other.slice(1)] }, identity)).toThrow("六个频段");
  expect(() => prepareZzzTuningUpdate(old, replaceFirst({ ...first, records: [] }), identity)).toThrow("S 级明细与官方汇总");
  expect(() => prepareZzzTuningUpdate(old, replaceFirst({ ...first, periods: [] }), identity)).toThrow("S 级明细与官方汇总");
  expect(() => prepareZzzTuningUpdate(old, replaceFirst({ ...first, records: [{ ...item, version: "1.1" }] }), identity))
    .toThrow("S 级明细与官方汇总");
  expect(() => prepareZzzTuningUpdate({ ...old, uid: "123456780" }, current, identity)).toThrow("UID 或分区");
  expect(() => prepareZzzTuningUpdate(old, { ...current, region: "prod_qd_cn" }, identity)).toThrow("UID 或分区");
});

test("accepts the v1 writer's cross-period duplicate and keeps known zero and nullable metadata", () => {
  const raw = snapshot();
  const first = raw.pools[0]!;
  const otherPeriod = { ...first.periods[0]!, version: "1.1", records: [{ ...item, version: "1.1" }],
    items: [], firstUp: null };
  const old = { ...raw, inventory: undefined, pools: [{ ...first, periods: [...first.periods, otherPeriod] }, ...raw.pools.slice(1)] };
  const read = readZzzTuningHistory(old, identity)!;
  expect(read.inventory).toEqual({});
  expect(read.pools[0]).toMatchObject({ pity: 0, guaranteedWithin: null, totalS: 1, records: [item] });
  expect(read.pools[0]!.periods).toHaveLength(2);
  expect(prepareZzzTuningUpdate(null, snapshot(later, 2), identity).pools[0]!.added).toBe(1);
});
