import { expect, test } from "bun:test";
import { resolveGenshinDetailPool, type GenshinDisplayPool } from "../plugins/genshin/gacha-detail.ts";
import { buildGenshinGachaSpecial, type GenshinSpecialPoolView } from "../plugins/genshin/gacha-special.ts";

const uid = "100000002";
const regular = [{
  from: "2023-11-08 06:00:00", to: "2023-11-28 17:59:59", char5: ["芙宁娜"], weapon5: ["静水流涌之辉"],
}];
const mix = [{
  from: "2024-03-13 06:00:00", to: "2024-04-02 17:59:59", char5: ["优菈", "可莉"], weapon5: ["松籁响起之时"],
}];

function rows(pool: GenshinDisplayPool, names: readonly [string, number, "角色" | "武器"][], day: string) {
  return names.map(([name, rank_type, item_type], index) => ({
    uid, gacha_type: String(pool), id: String(1700000000000000000n + BigInt(pool * 100 + names.length - index)),
    name, rank_type: String(rank_type), item_type, time: `${day} 12:${String(24 - index).padStart(2, "0")}:00`,
  }));
}

const beginner = rows(100, [
  ["冷刃", 3, "武器"], ["诺艾尔", 4, "角色"], ["冷刃", 3, "武器"], ["迪卢克", 5, "角色"],
  ["讨龙英杰谭", 3, "武器"], ["冷刃", 3, "武器"],
], "2023-03-06");
const records = {
  301: rows(301, [
    ["冷刃", 3, "武器"], ["芙宁娜", 5, "角色"], ["砂糖", 4, "角色"], ["冷刃", 3, "武器"],
    ["莫娜", 5, "角色"], ["西风剑", 4, "武器"], ["芙宁娜", 5, "角色"], ["班尼特", 4, "角色"],
  ], "2023-11-22"),
  302: rows(302, [
    ["祭礼剑", 4, "武器"], ["静水流涌之辉", 5, "武器"], ["冷刃", 3, "武器"], ["天空之刃", 5, "武器"],
    ["祭礼剑", 4, "武器"],
  ], "2023-11-21"),
  500: rows(500, [["砂糖", 4, "角色"], ["优菈", 5, "角色"]], "2024-03-22"),
  200: rows(200, [["天空之刃", 5, "武器"], ["冷刃", 3, "武器"]], "2023-10-20"),
};
const options = { uid, records, beginner, resolvePool: resolveGenshinDetailPool(regular, mix) };
const metrics = (pane: GenshinSpecialPoolView) =>
  Object.fromEntries(pane.line.flatMap((line) => line.map(({ lable, num }) => [lable, num])));

test("reads 100 alone and reproduces the old beginner card's observed statistics and icon", () => {
  const result = buildGenshinGachaSpecial({ ...options, type: "beginner",
    resolveItem(record) {
      expect(record.pool).toBe(100);
      return { id: 10000016, name: record.name, abbr: "迪卢克", img: "meta-gs/character/迪卢克/imgs/face.webp" };
    },
  })!;
  expect(result).toMatchObject({ game: "gs", uid, poolName: "新手", totalNum: 6 });
  const pane = result.data[0]!;
  expect(pane).toMatchObject({ type: 100, typeName: "新手", allNum: 6, fourNum: 1, fiveNum: 1, pity: 3,
    firstTime: "2023-03-06 12:19", lastTime: "2023-03-06 12:24", fiveLog: [
      { name: "迪卢克", abbrName: "迪卢克", item_type: "角色", icon: "meta-gs/character/迪卢克/imgs/face.webp",
        num: 3, date: "2023-03-06 12:21" },
    ],
  });
  expect(pane.fiveLog[0]!.isUp).toBeUndefined();
  expect(pane.max).toBeUndefined();
  expect(metrics(pane)).toEqual({
    未出五星: 3, 五星: 1, 五星平均: 3, 五星武器: 0, 最非: 3, 未出四星: 1, 四星: 1, 四星平均: 5, 四星最多: 1, 最欧: 3,
  });
});

test("keeps the cross-pool 301/302/500/200 order and each pool's own range, ranks and threshold", () => {
  const model = buildGenshinGachaSpecial({ ...options, type: "all" })!;
  expect(model).toMatchObject({ poolName: "全部", totalNum: 23 });
  expect(model.data.map(({ type, firstTime, max, fiveNum }) => [type, firstTime, max, fiveNum])).toEqual([
    [301, "2023-11-22 12:17", 90, 3], [302, "2023-11-21 12:20", 80, 2],
    [500, "2024-03-22 12:23", 90, 1], [200, "2023-10-20 12:23", 90, 1],
    [100, "2023-03-06 12:19", undefined, 1],
  ]);
  expect(metrics(model.data[0]!)).toMatchObject({ 小保底不歪: "50.0%", UP平均: 4, UP花费原石: "640", 五星常驻: 1 });
  expect(metrics(model.data[1]!)).toMatchObject({ 未出四星: 0, 四星平均: 3, 四星武器: 2 });
  expect(model.data[2]!.fiveLog[0]).toMatchObject({ name: "优菈", isUp: true });
  expect(metrics(model.data[3]!)).toMatchObject({ 五星武器: 1, 未出四星: 2 });
});

test("falls back to the real beginner records only for an archive without main-pool records", () => {
  const fallback = buildGenshinGachaSpecial({ ...options, records: {}, type: "all" })!;
  expect(fallback).toMatchObject({ poolName: "全部", totalNum: 6, data: [{ type: 100, uid, typeName: "新手" }] });
  expect(() => buildGenshinGachaSpecial({ ...options, beginner: {}, type: "all" })).toThrow("逐抽数组");
  expect(buildGenshinGachaSpecial({ ...options, beginner: undefined, type: "all" })?.data).toHaveLength(4);
  expect(buildGenshinGachaSpecial({ uid, type: "all", records: {} })).toBeUndefined();
  expect(buildGenshinGachaSpecial({ uid, type: "beginner", records })).toBeUndefined();
  expect(() => buildGenshinGachaSpecial({ ...options, type: "beginner",
    beginner: [{ ...beginner[0], uid: "100000005" }] })).toThrow("当前角色或卡池");
});

test("does not invent dates, rarity records, or rates for an incomplete schedule or a no-five-star pool", () => {
  const unknown = buildGenshinGachaSpecial({ uid, type: "all", records: {
    301: [{ ...records[301][1], time: "2024-02-31 08:00:00" }],
    302: [records[302][0]],
  } })!;
  const theater = unknown.data[0]!;
  expect(theater).toMatchObject({ firstTime: "暂无", lastTime: "暂无", fiveLog: [{ name: "芙宁娜", num: 1 }] });
  expect(theater.fiveLog[0]!.date).toBeUndefined();
  expect(theater.fiveLog[0]!.isUp).toBeUndefined();
  expect(metrics(theater)).toMatchObject({ 小保底不歪: "-", UP平均: "-", UP花费原石: "-", 五星常驻: "-" });
  const weapon = unknown.data[1]!;
  expect(weapon).toMatchObject({ fourNum: 1, fiveNum: 0, pity: 1, fiveLog: [] });
  expect(metrics(weapon)).toMatchObject({ 五星平均: "-", 最非: "-", 最欧: "-" });
});
