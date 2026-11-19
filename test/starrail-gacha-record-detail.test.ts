import { expect, test } from "bun:test";
import { buildStarRailRecordDetail, type StarRailRecordDetailOptions } from "../plugins/starrail/gacha-record-detail.ts";
import type { StarRailRecordDraw } from "../plugins/starrail/gacha-record-source.ts";

const uid = "100000002";
const face = { name: "测试开拓者" };
const now = new Date("2023-11-01T18:00:00.000Z");
const names = {
  "1001": ["三月七", "char"], "1003": ["姬子", "char"], "1110": ["玲可", "char"], "1202": ["停云", "char"],
  "1208": ["符玄", "char"], "1212": ["镜流", "char"], "1213": ["丹恒•饮月", "char"],
  "20000": ["锋镝", "weapon"], "21004": ["记忆中的模样", "weapon"], "21019": ["在蓝天下", "weapon"],
  "23014": ["此身为剑", "weapon"], "23011": ["她已闭上双眼", "weapon"],
} as const;
type ItemId = keyof typeof names;

function raw(id: number, date: string, itemId: ItemId, rank: StarRailRecordDraw["rank"],
  pool: StarRailRecordDraw["pool"] = "11"): StarRailRecordDraw {
  const [name, kind] = names[itemId];
  return { id: String(1700000000000000000n + BigInt(id)), pool, gachaId: "2001", rank,
    at: new Date(`${date.replace(" ", "T")}+08:00`).getTime(),
    item: { id: itemId, name, kind, abbr: itemId === "1213" ? "饮月" : name, img: `meta-sr/${name}/face.webp` },
  };
}

// These are the same character and light-cone records used to exercise the old Miao detail model.
const roleDraws = Object.freeze([
  raw(20, "2023-10-15 12:12:06", "20000", 3), raw(19, "2023-10-15 12:12:05", "1001", 4),
  raw(18, "2023-10-15 12:12:04", "1212", 5), raw(17, "2023-10-15 12:12:03", "20000", 3),
  raw(16, "2023-10-15 12:12:02", "1202", 4), raw(15, "2023-10-15 12:12:01", "1003", 5),
  raw(14, "2023-10-15 12:12:00", "20000", 3), raw(13, "2023-09-21 12:12:02", "1110", 4),
  raw(12, "2023-09-21 12:12:01", "1208", 5), raw(11, "2023-09-21 12:12:00", "20000", 3),
  raw(10, "2023-09-03 12:12:02", "1001", 4), raw(9, "2023-09-03 12:12:01", "1213", 5),
  raw(8, "2023-09-03 12:12:00", "20000", 3),
]);
const lightConeDraws = Object.freeze([
  raw(26, "2023-10-15 12:12:02", "21004", 4, "12"), raw(25, "2023-10-15 12:12:01", "23014", 5, "12"),
  raw(24, "2023-10-15 12:12:00", "20000", 3, "12"), raw(23, "2023-09-21 12:12:02", "21019", 4, "12"),
  raw(22, "2023-09-21 12:12:01", "23011", 5, "12"), raw(21, "2023-09-21 12:12:00", "20000", 3, "12"),
]);
const options = { uid, face, now, draws: [...roleDraws, ...lightConeDraws],
  resolvePool: (draw: StarRailRecordDraw) => ({ isUp: draw.item.id !== "1003" }) };
function build(overrides: Partial<StarRailRecordDetailOptions> = {}) {
  return buildStarRailRecordDetail({ ...options, ...overrides })!;
}

test("真实逐抽角色池匹配旧详情的真实金紫、保底顺序、日期、头像与四星频数", () => {
  const before = structuredClone(options.draws);
  const { gacha, poolName } = build();
  expect(poolName).toBe("角色");
  expect(gacha.stat).toMatchObject({ allNum: 13, noFiveNum: 2, noFourNum: 1, fiveNum: 4, fourNum: 4,
    wai: 1, weaponFourNum: 0, fiveAvg: "3.00", fourAvg: "3.00", isvalidNum: "4.50", upYs: "720" });
  expect(gacha.items["1001"]).toMatchObject({ star: 4, count: 2, name: "三月七", type: "char" });
  expect(gacha.items["20000"]).toMatchObject({ star: 3, count: 5, name: "锋镝", type: "weapon" });
  expect(gacha.items["1213"]).toMatchObject({ abbr: "饮月", img: "meta-sr/丹恒•饮月/face.webp" });
  expect(gacha.maxFour).toMatchObject({ name: "三月七", count: 2, star: 4 });
  expect(gacha.fiveLog.map(({ id, count, date, isUp, isBig }) => [String(id), count, date, isUp, isBig])).toEqual([
    ["888", 2, "11-02", true, undefined], ["1212", 3, "10-15", true, true],
    ["1003", 3, "10-15", false, undefined], ["1208", 3, "09-21", true, undefined],
    ["1213", 2, "09-03", true, undefined],
  ]);
  expect(gacha.fiveLog.at(-1)?.countAtLeast).toBe(true);
  expect(gacha.noWaiRate).toBe("50.0");
  expect(gacha.luck).toMatchObject({ smallNum: 2, smallWin: 1, bigNum: 1, isUpPool: true });
  expect(options.draws).toEqual(before);
});

test("同池分页只切金卡，不重复垫抽，顶部数字继续取完整所选池", () => {
  const truncated = build({ maxRows: 2 });
  const first = build({ maxRows: 2, page: 1 });
  const second = build({ maxRows: 2, page: 2 });
  expect(truncated.gacha).toMatchObject({ shownNum: 2, hiddenNum: 2, fiveLog: first.gacha.fiveLog });
  expect(first.pageInfo).toEqual({ page: 1, total: 2, from: 1, to: 2, count: 4 });
  expect(second.pageInfo).toEqual({ page: 2, total: 2, from: 3, to: 4, count: 4 });
  expect(second.gacha.fiveLog.map(({ id }) => id)).toEqual(["1208", "1213"]);
  expect(second.gacha.stat).toEqual(first.gacha.stat);
  expect(build({ maxRows: 0, page: 1 }).gacha.fiveLog).toHaveLength(5);
  expect(() => build({ maxRows: 2, page: 3 })).toThrow(RangeError);
  expect(() => build({ maxRows: 0, page: 2 })).toThrow(RangeError);
});

test("光锥卡池保留两张实际四星光锥，最新就是四星时四星垫抽为零", () => {
  const { poolName, gacha } = build({ pool: "GachaType_EquipmentUp" });
  expect(poolName).toBe("光锥");
  expect(gacha.stat).toMatchObject({ allNum: 6, fiveNum: 2, fourNum: 2, noFiveNum: 1, noFourNum: 0, weaponFourNum: 2 });
  expect(gacha.fiveLog.map(({ id }) => id)).toEqual([888, "23014", "23011"]);
  expect(gacha.stat).toMatchObject({ fiveAvg: "3.00", fourAvg: "3.00", isvalidNum: "3.00" });
  expect(build({ pool: "GachaType_Standard" })).toBeUndefined();
});

test("未知星级留下确定的计数与部分区间，不补垫抽、平均或运气评分", () => {
  const change = new Set([roleDraws[0]!.id, roleDraws[3]!.id]);
  const draws = roleDraws.map((row) => change.has(row.id) ? { ...row, rank: undefined } : row);
  const { gacha } = build({ draws });
  expect(gacha.unclassified).toBe(2);
  expect(gacha.stat).toMatchObject({ allNum: 13, fiveNum: 4, fourNum: 4, noFiveNum: 0, noFourNum: 0, fiveAvg: 0,
    fourAvg: 0, isvalidNum: 0, upYs: "" });
  expect(gacha.fiveLog[0]).toMatchObject({ id: "1212", count: 0, countKnown: false });
  expect(gacha.fiveLog[1]).toMatchObject({ id: "1003", count: 3 });
  expect(gacha.fiveLog).toHaveLength(4);
  expect(gacha.noWaiRate).toBe(0);
  expect(gacha.luck).toBeUndefined();
  expect(gacha.items["20000"]?.count).toBe(3);
  expect(gacha.items["888"]).toBeUndefined();
});

test("按同秒内的精确长 ID 定序，日程未知不擅自标非 UP", () => {
  const at = "2023-12-31 23:59:59";
  const draws = Object.freeze([
    raw(9001, at, "1003", 5), raw(9000, at, "20000", 3),
    raw(9002, at, "1212", 5), raw(9003, at, "1001", 4), raw(9004, "2024-01-01 00:00:00", "20000", 3),
  ]);
  const { gacha } = build({ draws, resolvePool: undefined });
  expect(gacha.fiveLog.map(({ id, count, date, isUp }) => [id, count, date, isUp])).toEqual([
    [888, 2, "11-02", true], ["1212", 1, "12-31", undefined], ["1003", 2, "12-31", undefined],
  ]);
  expect(gacha.stat.wai).toBe(0);
  expect(gacha.luck?.isUpPool).toBe(false);
});

test("没有更早五星时只显示已知下限，缺少可比较区间就不报均值和概率", () => {
  const [three, four, five] = roleDraws;
  const { gacha } = build({ draws: [three!, four!, five!] });
  expect(gacha.fiveLog.map(({ id, count, countAtLeast }) => [id, count, countAtLeast])).toEqual([
    [888, 2, undefined], ["1212", 1, true],
  ]);
  expect(gacha.stat).toMatchObject({ allNum: 3, noFiveNum: 2, fiveAvg: 0, fourAvg: 0, upYs: "" });
  expect(gacha.luck).toBeUndefined();
  const noFive = build({ draws: [three!, four!] }).gacha;
  expect(noFive.fiveLog).toMatchObject([{ id: 888, count: 2, countAtLeast: true }]);
  expect(noFive.luck).toBeUndefined();
});
