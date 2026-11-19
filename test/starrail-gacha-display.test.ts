import { expect, test } from "bun:test";
import { buildStarRailLegacyRecords, type StarRailLegacyGachaRecord } from "../plugins/starrail/gacha-display.ts";

const uid = "512345678";
const utc = "2024-01-01 00:00:00";
const explicit = "2024-02-11 17:30:00";
const oldest = "2023-05-01 10:00:00";
const numericId = "1704067200000001920";

test("旧 display 兼容快照保留六种跃迁、五星编号和 UP 事实，按抽数补齐显示占位", () => {
  const oldLog = {
    uid, profileId: 2, privateFixture: "outside display payload",
    pools: {
      GachaType_AvatarUp: {
        pity: "2", totalDraws: "7",
        fiveStars: [
          { id: numericId, item: { item_type: "ItemType_Avatar", name: "夹具角色" }, is_up: true, gacha_count: 2 },
          { uuid: "archive-id", legacy_time: oldest, item: { name: "夹具光锥" }, is_up: false, gacha_count: "2" },
        ],
      },
      GachaType_EquipmentUp: { fiveStars: [{ id: "weapon-id", time: explicit, legacy_time: oldest, gacha_count: 0 }] },
      GachaType_CollabAvatarUp: { fiveStars: [{ id: "collab-role" }] },
      GachaType_CollabEquipmentUp: { fiveStars: [{ id: "collab-weapon" }] },
      GachaType_Standard: { pity: 1 },
      GachaType_Newbie: {},
      unknownPool: { totalDraws: 1 },
    },
  };
  const before = structuredClone(oldLog);
  const records = buildStarRailLegacyRecords(uid, oldLog);
  expect(Object.keys(records)).toEqual(["1", "2", "11", "12", "21", "22"]);
  const filler = (number: number, time: string): StarRailLegacyGachaRecord => ({
    id: `lotus-11-${number}`, uid, name: "占位记录", item_type: "光锥", rank_type: "3", gacha_type: "11", time,
  });

  expect(records[11]).toEqual([
    filler(1, utc), filler(2, utc),
    { id: numericId, uid, name: "夹具角色", item_type: "角色", rank_type: "5", gacha_type: "11", is_up: true, time: utc },
    filler(3, utc),
    { id: "archive-id", uid, name: "夹具光锥", item_type: "光锥", rank_type: "5", gacha_type: "11", is_up: false, time: oldest },
    filler(4, oldest), filler(5, oldest),
  ]);
  expect(records[12]).toEqual([
    { id: "weapon-id", uid, name: "未知", item_type: "光锥", rank_type: "5", gacha_type: "12", time: explicit },
  ]);
  expect(records[21]).toMatchObject([{ id: "collab-role", rank_type: "5", gacha_type: "21" }]);
  expect(records[22]).toMatchObject([{ id: "collab-weapon", rank_type: "5", gacha_type: "22" }]);
  expect(records[1]).toEqual([{
    id: "lotus-1-1", uid, name: "占位记录", item_type: "光锥",
    rank_type: "3", gacha_type: "1", time: "1970-01-01 00:00:00",
  }]);
  expect(records[2]).toEqual([]);
  expect(JSON.stringify(records)).not.toContain("outside display payload");
  expect(oldLog).toEqual(before);
});

test("旧显示会保留已知的垫抽间距，匿名五星和占位取得不同的合成编号", () => {
  const snapshot = { pools: { GachaType_AvatarUp: {
    pity: 1, totalDraws: 1,
    fiveStars: [{}, {}, { id: "lotus-11-1", gacha_count: 2 }, { uuid: "lotus-five-11-1" }],
  } } };
  const rows = buildStarRailLegacyRecords(uid, snapshot)[11];
  expect(rows).toHaveLength(6);
  expect(rows.map(({ id }) => id)).toEqual([
    "lotus-11-2", "lotus-five-11-2", "lotus-five-11-3", "lotus-11-1", "lotus-11-3", "lotus-five-11-1",
  ]);
  expect(rows.map(({ rank_type }) => rank_type)).toEqual(["3", "5", "5", "5", "3", "5"]);
  expect(buildStarRailLegacyRecords(uid, snapshot)[11]).toEqual(rows);
});

test("空旧档返回六个空池，错误角色、损坏列表和超大合成快照中止转换", () => {
  const empty = buildStarRailLegacyRecords(uid, null);
  expect(empty).toEqual({ 1: [], 2: [], 11: [], 12: [], 21: [], 22: [] });
  expect(() => buildStarRailLegacyRecords("bad", null)).toThrow("UID 无效");
  expect(() => buildStarRailLegacyRecords(uid, { uid: "512345679" })).toThrow("与当前角色不一致");
  expect(() => buildStarRailLegacyRecords(uid, { pools: [] })).toThrow("卡池清单格式无效");
  expect(() => buildStarRailLegacyRecords(uid, { pools: { GachaType_Newbie: { fiveStars: [null] } } }))
    .toThrow("五星显示记录格式无效");
  expect(() => buildStarRailLegacyRecords(uid, { pools: { GachaType_Newbie: { totalDraws: Number.MAX_SAFE_INTEGER } } }))
    .toThrow("显示记录数量过多");
});
