import { expect, test } from "bun:test";
import type { StarRailRecordDraw } from "../plugins/starrail/gacha-record-source.ts";
import { buildStarRailRecordVersion, type StarRailRecordVersionOptions } from "../plugins/starrail/gacha-record-version.ts";

const uid = "100000002";
const schedule = [
  { version: "1.3", half: "上半", from: "2023-08-30 06:00:00", to: "2023-09-20 11:59:59",
    char5: ["丹恒•饮月"], weapon5: ["比阳光更明亮的"] },
  { version: "1.3", half: "下半", from: "2023-09-20 12:00:00", to: "2023-10-10 14:59:59",
    char5: ["符玄"], weapon5: ["她已闭上双眼"] },
  { version: "1.4", half: "上半", from: "2023-10-11 06:00:00", to: "2023-10-27 11:59:59",
    char5: ["镜流"], weapon5: ["此身为剑"] },
] as const;
const catalog = {
  "锋镝": { id: "20000", kind: "weapon", rank: 3 },
  "停云": { id: "1202", kind: "char", rank: 4 },
  "记忆中的模样": { id: "21004", kind: "weapon", rank: 4 },
  "姬子": { id: "1003", kind: "char", rank: 5 },
  "镜流": { id: "1212", kind: "char", rank: 5 },
  "符玄": { id: "1208", kind: "char", rank: 5 },
  "丹恒•饮月": { id: "1213", kind: "char", rank: 5, abbr: "饮月" },
  "此身为剑": { id: "23014", kind: "weapon", rank: 5 },
  "Saber": { id: "1014", kind: "char", rank: 5 },
  "没有回报的加冕": { id: "23045", kind: "weapon", rank: 5 },
} as const;
type Name = keyof typeof catalog;
let sequence = 0;

function pull(pool: StarRailRecordDraw["pool"], name: Name, date = "2023-10-15 12:12:00"): StarRailRecordDraw {
  const entry = catalog[name];
  const { id, kind, rank } = entry;
  return {
    pool, id: String(1_700_000_000_000_000_000n + BigInt(++sequence)), gachaId: "1000",
    at: Date.parse(date.replace(" ", "T") + "+08:00"), rank,
    item: { id, kind, name, abbr: "abbr" in entry ? entry.abbr : name, img: `fixture/${id}.webp` },
  };
}

const activity = [
  pull("11", "锋镝"), pull("11", "镜流"), pull("11", "停云"), pull("11", "姬子"),
  pull("12", "记忆中的模样"), pull("12", "此身为剑"),
  pull("11", "符玄", "2023-09-21 12:12:00"), pull("11", "丹恒•饮月", "2023-09-02 12:12:00"),
];
const other = [pull("21", "Saber"), pull("22", "没有回报的加冕"), pull("2", "姬子"), pull("1", "姬子")];
const options: StarRailRecordVersionOptions = { uid, face: { name: "测试" }, schedule, draws: [...activity, ...other] };

test("逐抽版期将真实三、四、五星归入原日历，只有活动池能判定 UP", () => {
  const gacha = buildStarRailRecordVersion(options)!.gacha;
  expect(gacha.totalStat).toMatchObject({
    totalNum: 8, star5Num: 5, star4Num: 2, c4Num: 1, w4Num: 1, w3Num: 1,
    c5UpNum: 3, w5UpNum: 1, upNum: 4, avgUpNum: "2.0", unassignedDraws: 0,
  });
  expect(gacha.versionData.map(({ version, half, name, stats }) => [version, half, name, stats.totalNum])).toEqual([
    ["1.4", "上半", "镜流", 6], ["1.3", "下半", "符玄", 1], ["1.3", "上半", "饮月", 1],
  ]);
  expect(gacha.versionData[0]?.items.map(({ id, star, isUp }) => [id, star, isUp])).toEqual([
    ["23014", 5, 1], ["1212", 5, 1], ["1003", 5, 0], ["21004", 4, 0], ["1202", 4, 0], ["20000", 3, 0],
  ]);
  expect(gacha.versionData[0]?.upIds).toEqual({ "1212": "镜流", "23014": "此身为剑" });
});

test("未知日期和未知星级保有抽数，未验证 UP 不进入平均值", () => {
  const unknownRank: StarRailRecordDraw = {
    ...pull("11", "锋镝"), rank: undefined, item: { id: "99999", name: "未知", abbr: "未知", img: "" },
  };
  const unknownDates = [
    { ...pull("11", "符玄"), at: NaN },
    pull("12", "记忆中的模样", "2023-10-10 20:00:00"),
    pull("11", "锋镝", "2023-10-11 06:00:00"),
  ];
  const gacha = buildStarRailRecordVersion({ ...options, draws: [...options.draws, unknownRank, ...unknownDates] })!.gacha;
  expect(gacha.totalStat).toMatchObject({
    totalNum: 12, star5Num: 6, star4Num: 3, unassignedDraws: 3, unassignedFiveStars: 1, unclassifiedDraws: 1,
    upNum: 4, avgUpNum: 0,
  });
  expect(gacha.itemMap["99999"]).toBeUndefined();
  expect(gacha.versionData.at(-1)).toMatchObject({
    version: "未判定期次", unassigned: true,
    stats: { totalNum: 3, star5Num: 1, star4Num: 1, w3Num: 1, upNum: 0 },
  });
  expect(gacha.versionData[0]?.stats.totalNum).toBe(7);
});

test("只有确认物品和吻合期次才标记 UP，编号和时间冲突时保留抽数", () => {
  const base = pull("11", "镜流");
  const unknownItem = { ...base, item: { ...base.item, id: "30000", img: "" } };
  const conflicting = { ...pull("11", "镜流"), gachaId: "1150" };
  const calendars = schedule.map((period) => period.half === "下半"
    ? { ...period, gachaIds: { GachaType_AvatarUp: ["1150"] } }
    : period);
  const draws = [pull("11", "镜流"), unknownItem, conflicting];
  const gacha = buildStarRailRecordVersion({ ...options, draws, schedule: calendars })!.gacha;
  expect(gacha.totalStat).toMatchObject({
    totalNum: 3, star5Num: 3, upNum: 1, avgUpNum: 0, unassignedDraws: 1, unassignedFiveStars: 1,
  });
  expect(gacha.versionData[0]?.upIds).toEqual({ "1212": "镜流" });
  expect(gacha.versionData[0]?.items.find(({ id }) => id === "30000")?.isUp).toBe(0);
});

test("全部统计沿用三主池单组，常驻仅计自身，联动和新手不混入", () => {
  const all = buildStarRailRecordVersion({ ...options, type: "all" })!.gacha;
  expect(all.totalStat).toMatchObject({ totalNum: 9, star5Num: 6, star4Num: 2, upNum: 4, unassignedDraws: 0 });
  expect(all.versionData).toHaveLength(1);
  expect(all.versionData[0]).toMatchObject({ version: "全部统计", from: "", to: "", stats: { totalNum: 9, upNum: 4 } });
  expect(all.itemMap["1014"]).toBeUndefined();
  expect(all.itemMap["23045"]).toBeUndefined();
  const normal = buildStarRailRecordVersion({ ...options, type: "normal" })!.gacha;
  expect(normal.versionData[0]).toMatchObject({ version: "常驻池", stats: { totalNum: 1, upNum: 0 } });
  expect(buildStarRailRecordVersion({ ...options, draws: other, type: "weapon" })).toBeUndefined();
});

test("逐抽版期总量保留在限量和分页模型上", () => {
  const original = buildStarRailRecordVersion(options)!;
  const limited = buildStarRailRecordVersion({ ...options, maxRows: 2 })!;
  const last = buildStarRailRecordVersion({ ...options, maxRows: 2, page: 2 })!;
  expect(limited.gacha).toMatchObject({ shownNum: 2, hiddenNum: 1 });
  expect(limited.gacha.versionData).toEqual(original.gacha.versionData.slice(0, 2));
  expect(last.pageInfo).toEqual({ page: 2, total: 2, from: 3, to: 3, count: 3 });
  expect(last.gacha.versionData).toEqual(original.gacha.versionData.slice(2));
  expect(last.gacha.totalStat).toEqual(original.gacha.totalStat);
  expect(() => buildStarRailRecordVersion({ ...options, maxRows: 2, page: 3 })).toThrow(RangeError);
});
