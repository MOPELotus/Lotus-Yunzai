import { expect, test } from "bun:test";
import { buildStarRailGachaDetail, type StarRailGachaDetailOptions } from "../plugins/starrail/gacha-detail.ts";

const uid = "100000002";
const face = { name: "星铁测试开拓者", face: "/meta-sr/character/卡芙卡/imgs/face.webp", banner: "meta-sr/character/common/imgs/banner.webp" };
const now = new Date("2026-11-18T18:00:00Z");
const history = {
  version: 1, uid,
  pools: {
    GachaType_AvatarUp: {
      totalDraws: 172, pity: 17, fiveStars: [
        { id: "169154640000000001", time: "2023-08-09 13:00:00", is_up: true, gacha_count: 80,
          item: { name: "卡芙卡", item_type: "ItemType_Avatar" } },
        { id: "169154280000000002", time: "2023-08-09 12:00:00", is_up: false, gacha_count: 72,
          item: { name: "瓦尔特", item_type: "ItemType_Avatar" } },
        { id: "169153920000000003", time: "2023-08-09 11:00:00", is_up: true, gacha_count: 3,
          item: { name: "卡芙卡", item_type: "ItemType_Avatar" } },
      ],
    },
  },
};
const resolveItem: StarRailGachaDetailOptions["resolveItem"] = ({ name }) => ({
  id: name === "卡芙卡" ? 1005 : 1004, name, abbr: name, img: `/meta-sr/character/${name}/imgs/face.webp`,
});

test("星铁角色活动池复现旧喵喵参考字段、五星间隔、歪/小保底/大保底及欧皇度", () => {
  const model = buildStarRailGachaDetail({
    uid, face, history, now, resolveItem,
    resolvePool: () => ({ isUp: false, isNewPool: false }),
  })!;
  expect(model).toMatchObject({ uid, face, poolName: "角色" });
  expect(model.pageInfo).toBeUndefined();
  expect(model.gacha.stat).toEqual({
    allNum: 172, noFiveNum: 17, noFourNum: 0, fiveNum: 3, fourNum: 0,
    fiveAvg: "51.67", fourAvg: 0, wai: 1, isvalidNum: "77.50", weaponNum: 0, weaponFourNum: 0, upYs: "1.24w",
  });
  expect(model.gacha.fiveLog).toEqual([
    { id: 888, isUp: true, count: 17, date: "11-19" },
    { id: 1005, isUp: true, isBig: true, isNewPool: false, count: 80, date: "08-09" },
    { id: 1004, isUp: false, isNewPool: false, count: 72, date: "08-09" },
    { id: 1005, isUp: true, isNewPool: false, count: 3, date: "08-09" },
  ]);
  expect(model.gacha.items[403]).toEqual({ type: "weapon", count: 169, star: 3, name: "未知", abbr: "未知", img: "" });
  expect(model.gacha.items[1005]).toMatchObject({ count: 2, star: 5, name: "卡芙卡" });
  expect(model.gacha.noWaiRate).toBe("50.0");
  expect(model.gacha.luck).toEqual({
    min: 55, title: "小有运气", desc: "运气略好于平均", color: "#c9cf8a", isUpPool: true,
    fiveAvg: "51.7", fiveExpect: "62.3", fivePercent: "80.2", upAvg: "77.5", upExpect: "93.4",
    upRate: 50, winPercent: "50.0", percent: "69.6", fewSample: true, smallNum: 2, smallWin: 1,
    bigNum: 1, maxUpStreak: 1, maxWaiStreak: 1, noWaiRate: "50.0", hasNewPool: false,
  });
});

test("光锥和常驻使用各自原版模型，缺失真实日期时不展示占位日期", () => {
  const dated = {
    pity: 4, totalDraws: 64, fiveStars: [{ uuid: "missing-time", gacha_count: 60, item: { name: "夹具光锥" } }],
  };
  const poolHistory = { uid, pools: { GachaType_EquipmentUp: dated, GachaType_Standard: dated } };
  const input = { uid, face, history: poolHistory, now, resolvePool: () => ({ isUp: true, isNewPool: true }) };
  const weapon = buildStarRailGachaDetail({ ...input, pool: "GachaType_EquipmentUp" })!;
  const standard = buildStarRailGachaDetail({ ...input, pool: "GachaType_Standard" })!;
  expect(weapon.poolName).toBe("光锥");
  expect(weapon.gacha.fiveLog).toMatchObject([
    { id: 888, count: 4, date: "11-19" }, { isUp: true, isNewPool: true, count: 60, date: "" },
  ]);
  expect(weapon.gacha.luck).toMatchObject({ isUpPool: true, upRate: 75, hasNewPool: true, fiveAvg: "60.0" });
  expect(standard.poolName).toBe("常驻");
  expect(standard.gacha.luck).toMatchObject({ isUpPool: false, fiveExpect: "62.3", fewSample: true });
  expect(standard.gacha.luck?.upRate).toBeUndefined();
  expect(standard.gacha.fiveLog.at(-1)?.isBig).toBeUndefined();
});

test("空池、仅有垫抽和未知 UP 标记可区分，分页保留全量统计", () => {
  const input = { uid, face, now };
  expect(buildStarRailGachaDetail({ ...input, history: null })).toBeUndefined();
  const onlyPity = buildStarRailGachaDetail({
    ...input, history: { uid, pools: { GachaType_AvatarUp: { totalDraws: 107, pity: 7 } } },
  })!;
  expect(onlyPity.gacha.stat).toMatchObject({ allNum: 107, noFiveNum: 7, fiveNum: 0, fiveAvg: 0 });
  expect(onlyPity.gacha.fiveLog).toEqual([{ id: 888, isUp: true, count: 7, date: "11-19" }]);
  expect(onlyPity.gacha.luck).toBeUndefined();
  const unknown = buildStarRailGachaDetail({
    ...input,
    history: { uid, pools: { GachaType_AvatarUp: {
      fiveStars: [{ id: "unknown-item", gacha_count: 60, item: { name: "未知角色" } }],
    } } },
  })!;
  expect(unknown.gacha.stat).toMatchObject({ wai: 0, fiveNum: 1, isvalidNum: 0 });
  expect(unknown.gacha.fiveLog[0]?.isUp).toBeUndefined();
  expect(unknown.gacha.luck?.isUpPool).toBe(false);

  const clipped = buildStarRailGachaDetail({ ...input, history, resolveItem, maxRows: 1 })!;
  expect(clipped.gacha).toMatchObject({ shownNum: 1, hiddenNum: 2, stat: { fiveNum: 3 } });
  expect(clipped.gacha.fiveLog.map(({ id }) => id)).toEqual([888, 1005]);
  const first = buildStarRailGachaDetail({ ...input, history, resolveItem, maxRows: 1, page: 1 })!;
  expect(first.pageInfo).toEqual({ page: 1, total: 3, from: 1, to: 1, count: 3 });
  expect(first.gacha.fiveLog.map(({ id }) => id)).toEqual([888, 1005]);
  const second = buildStarRailGachaDetail({ ...input, history, resolveItem, maxRows: 1, page: 2 })!;
  expect(second.pageInfo).toEqual({ page: 2, total: 3, from: 2, to: 2, count: 3 });
  expect(second.gacha.fiveLog.map(({ id }) => id)).toEqual([1004]);
  expect(second.gacha.stat).toEqual(first.gacha.stat);
});
