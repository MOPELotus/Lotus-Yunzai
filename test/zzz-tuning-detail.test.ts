import { expect, test } from "bun:test";
import { zzzTuningPools, type ZzzTuningSnapshot } from "../packages/hoyo-client/index.ts";
import { buildZzzTuningDetail, buildZzzTuningInventoryReply } from "../plugins/zzz/tuning-detail.ts";

type Pool = ZzzTuningSnapshot["pools"][number];
type Item = Pool["records"][number];
const uid = "123456789";
const first = Date.parse("2024-01-01T16:00:00Z") / 1000;
const latest = Date.parse("2024-01-02T16:00:01Z") / 1000;
const icon = "https://example.invalid/fixture.webp";

function item(itemId: string, count: Item["count"], time: Item["time"], sort: string, isUp = false): Item {
  return { itemId, name: `测试物品 ${itemId}`, count, time, sort, isUp, icon, rarity: "S", itemType: "WEAPON", upTag: "", version: "1.2" };
}

function fixture(): ZzzTuningSnapshot {
  const all: Partial<Record<Pool["type"], Partial<Pool>>> = {
    GACHA_TYPE_CHARACTER_UP: {
      totalDraws: 250, totalS: 3, upCount: 2, averageUp: 99, pity: 0,
      records: [item("1", 60, first, "1", true), item("2", 80, latest, "2"), item("3", 70, latest, "12", true)],
    },
    GACHA_TYPE_WEAPON_UP: {
      totalDraws: 138, totalS: 2, upCount: 1, pity: 18,
      records: [item("4", 50, first, "1"), item("5", 70, latest, "12", true)],
    },
    GACHA_TYPE_WEAPON_RETURN: { totalDraws: 14, pity: 14 },
    GACHA_TYPE_BANGBOO: {
      totalDraws: 70, totalS: 1, upCount: 1, averageUp: 70,
      records: [item("6", 70, latest, "1", true)],
    },
  };
  return {
    version: 1, uid, region: "prod_gf_cn", profileId: 1, currentVersion: "1.2", updatedAt: "2026-11-01T00:00:00.000Z",
    totalDraws: 402, totalS: 5, inventory: {},
    pools: (Object.keys(zzzTuningPools) as Pool["type"][]).map((type) => ({
      type, name: zzzTuningPools[type].name, totalDraws: 0, totalS: 0, upCount: null, averageUp: null,
      pity: null, guaranteedWithin: null, records: [], periods: [], ...all[type],
    })),
  };
}

test("recreates the original six-band card ordering, meaningful counters and real S history bounds", () => {
  const stats = fixture();
  const card = buildZzzTuningDetail({ stats, player: { nickname: "绳匠", avatar: "file:///fixture/avatar.webp" } });
  expect(card.uid).toBe(uid);
  expect(card.nickname).toBe("绳匠");
  expect(card.avatar).toBe("file:///fixture/avatar.webp");
  expect(card.data.map(({ name }) => name)).toEqual(["独家频段", "独家重映", "音擎频段", "音擎回响", "常驻频段", "邦布频段"]);
  expect(card.data[0]).toMatchObject({
    lastFive: 0, fiveStars: 3, upCount: 2, totalCount: 250,
    timeRange: "2024-01-03 00:00:01 ～ 2024-01-02 00:00:00（S级）",
    avgFive: "70.0", avgUp: "99.0", avgUpEstimated: false, noWai: "50%", noWaiEstimated: true,
    level: 2, emoji: 16, tag: "平稳保底",
  });
  expect(card.data[0]!.list.map(({ itemId, totalCount, color, square_icon }) => [itemId, totalCount, color, square_icon])).toEqual([
    ["3", "70", "white", icon], ["2", "80", "rgb(255, 20, 20)", icon], ["1", "60", "rgb(63, 255, 0)", icon],
  ]);
  expect(stats.pools.find(({ type }) => type === "GACHA_TYPE_CHARACTER_UP")!.records.map(({ itemId }) => itemId)).toEqual(["1", "2", "3"]);
  expect(card.data[2]).toMatchObject({
    lastFive: 18, avgFive: "60.0", avgUp: "120.0", avgUpEstimated: true, level: 0,
    list: [{ color: "rgb(255, 20, 20)", isUp: true }, { color: "rgb(63, 255, 0)", isUp: false }],
  });
  expect(card.data[3]).toMatchObject({ lastFive: 14, totalCount: 14, timeRange: "暂无 S 级记录", avgFive: "-", avgUp: "-", list: [] });
  expect(card.data[4]).toMatchObject({ lastFive: "-", totalCount: 0, timeRange: "还没有抽卡", noWai: "-", noWaiEstimated: false });
  expect(card.data[5]).toMatchObject({ lastFive: "-", totalCount: 70, avgFive: "70.0", avgUp: "70.0", noWai: "-", level: 0 });
});

test("keeps missing intervals and dates unknown and resolves icons only through the provided local lookup", () => {
  const baseline = fixture();
  const edited = baseline.pools.map((pool): Pool => pool.type === "GACHA_TYPE_CHARACTER_UP"
    ? { ...pool, averageUp: null, records: [item("1", null, null, "1"), item("2", 3, latest, "2", true)] } : pool);
  const local = buildZzzTuningDetail({
    stats: { ...baseline, pools: edited }, player: { nickname: "绳匠" },
    resolveIcon(record) { return record.itemId === "2" ? "/fixtures/item2.webp" : undefined; },
  });
  expect(local.avatar).toBeUndefined();
  expect(local.data[0]).toMatchObject({ avgFive: "-", avgUp: "-", avgUpEstimated: false, totalCount: 250 });
  expect(local.data[0]!.list).toMatchObject([
    { itemId: "2", totalCount: "3", square_icon: "/fixtures/item2.webp", date: "2024-01-03 00:00:01", version: "1.2" },
    { itemId: "1", totalCount: "-", color: "white", square_icon: "" },
  ]);
  expect(local.data[0]!.list[1]!.date).toBeUndefined();

  const untrusted = baseline.pools.map((pool): Pool => pool.type === "GACHA_TYPE_BANGBOO"
    ? { ...pool, records: pool.records.map((row) => ({ ...row, icon: "file:///path/fixture" })) } : pool);
  expect(buildZzzTuningDetail({ stats: { ...baseline, pools: untrusted }, player: { nickname: "" } })
    .data.at(-1)!.list[0]!.square_icon).toBe("");
});

test("formats only live inventory for the displayed UID, with authoritative zeroes and the current profile id", () => {
  expect(buildZzzTuningInventoryReply({ uid, profileId: 3 })).toBeUndefined();
  expect(buildZzzTuningInventoryReply({ uid, profileId: 3, live: { uid: "123456788", inventory: { boopon: 1 } } })).toBeUndefined();
  expect(buildZzzTuningInventoryReply({ uid, profileId: 3, live: { uid, inventory: { masterTape: -1, boopon: 1.2 } } })).toBeUndefined();
  const inventory = { polychrome: 1_234, monochrome: 0, encryptedMasterTape: 11, masterTape: 2, boopon: 0 };
  expect(buildZzzTuningInventoryReply({ uid, profileId: 3, live: { uid, inventory } })).toBe(
    "档案 3（UID: 123456789）\n当前库存：\n菲林 × 1,234 · 菲林底片 × 0\n加密母带 × 11 · 原装母带 × 2 · 邦布券 × 0",
  );
});
