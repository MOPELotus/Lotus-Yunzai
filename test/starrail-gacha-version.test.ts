import { expect, test } from "bun:test";
import { buildStarRailGachaVersion, type StarRailGachaSchedulePeriod } from "../plugins/starrail/gacha-version.ts";

const uid = "100000002";
const face = { name: "夹具" };
const schedule: readonly StarRailGachaSchedulePeriod[] = [
  { version: "1.1", half: "下半", from: "2023-06-28 12:00:00", to: "2023-07-18 14:59:59", char5: ["罗刹"] },
  { version: "1.2", half: "下半", from: "2023-08-09 12:00:00", to: "2023-08-29 14:59:59",
    char5: ["卡芙卡"], weapon5: ["只需等待"] },
  { version: "1.3", half: "下半", from: "2023-09-20 12:00:00", to: "2023-10-10 14:59:59",
    char5: ["符玄"], weapon5: ["她已闭上双眼"] },
];
const itemIds: Record<string, number> = { 罗刹: 1203, 卡芙卡: 1005, 瓦尔特: 1004, 符玄: 1208, 她已闭上双眼: 23011, 只需等待: 23006 };
const resolveItem = ({ name }: { name: string }) => ({ id: itemIds[name]!, name, abbr: name });
const inputs = { uid, face, schedule, resolveItem };
const five = (id: string, time: string, name: string, is_up: boolean | undefined, item_type = "ItemType_Avatar", draws = 1) => ({
  id, time, is_up, gacha_count: draws, item: { name, item_type },
});
const history = {
  uid, pools: {
    GachaType_AvatarUp: {
      totalDraws: 4,
      fiveStars: [
        five("169528200000000001", "2023-09-21 13:00:00", "符玄", true),
        five("169163640000000002", "2023-08-10 13:00:00", "卡芙卡", true),
        five("169154640000000003", "2023-08-09 13:00:00", "瓦尔特", false),
        five("168810120000000004", "2023-06-30 13:00:00", "罗刹", true),
      ],
    },
    GachaType_EquipmentUp: {
      totalDraws: 2,
      fiveStars: [
        five("169528200000000005", "2023-09-21 05:01:00Z", "她已闭上双眼", true, "ItemType_Weapon"),
        five("169154640000000006", "2023-08-09 13:01:00", "只需等待", true, "ItemType_Weapon"),
      ],
    },
    GachaType_Standard: {
      totalDraws: 1, fiveStars: [five("169875720000000007", "2023-10-31 13:00:00", "瓦尔特", false)],
    },
  },
};
const genuineFixtureTotals = {
  w5Num: 2, w5UpNum: 2, c5Num: 4, c5UpNum: 3, c4Num: 0, w4Num: 0, w3Num: 0,
  upNum: 5, star5Num: 6, star4Num: 0, totalNum: 6, avgUpNum: "1.2", unassignedDraws: 0, unassignedFiveStars: 0,
};

test("旧真实时间夹具复现角色/光锥分期、全局表头、排序、分页和常驻汇总", () => {
  const model = buildStarRailGachaVersion({ ...inputs, history })!;
  expect(model.poolName).toBe("抽卡");
  expect(model.gacha.totalStat).toEqual(genuineFixtureTotals);
  expect(model.gacha.versionData.map(({ version, half, from, to, name, stats }) =>
    [version, half, from, to, name, stats.totalNum, stats.upNum])).toEqual([
    ["1.3", "下半", "23-09-20", "23-10-10", "符玄", 2, 2],
    ["1.2", "下半", "23-08-09", "23-08-29", "卡芙卡", 3, 2],
    ["1.1", "下半", "23-06-28", "23-07-18", "罗刹", 1, 1],
  ]);
  expect(model.gacha.versionData[1]?.items).toEqual([
    { id: "23006", num: 1, star: 5, isUp: 1 },
    { id: "1005", num: 1, star: 5, isUp: 1 },
    { id: "1004", num: 1, star: 5, isUp: 0 },
  ]);
  const shown = buildStarRailGachaVersion({ ...inputs, history, maxRows: 2 })!;
  expect(shown.gacha).toMatchObject({ shownNum: 2, hiddenNum: 1, totalStat: genuineFixtureTotals });
  const page2 = buildStarRailGachaVersion({ ...inputs, history, maxRows: 2, page: 2 })!;
  expect(page2.pageInfo).toEqual({ page: 2, total: 2, from: 3, to: 3, count: 3 });
  expect(page2.gacha.versionData.map(({ version }) => version)).toEqual(["1.1"]);
  expect(buildStarRailGachaVersion({ ...inputs, history, type: "char" })?.gacha.totalStat).toMatchObject({
    totalNum: 4, c5Num: 4, c5UpNum: 3, w5Num: 0,
  });
  expect(buildStarRailGachaVersion({ ...inputs, history, type: "weapon" })?.gacha.totalStat).toMatchObject({
    totalNum: 2, w5Num: 2, w5UpNum: 2, c5Num: 0,
  });
  const standard = buildStarRailGachaVersion({ ...inputs, history, type: "normal" })!;
  expect(standard.gacha.versionData).toMatchObject([{ version: "常驻池", from: "", to: "", stats: { totalNum: 1 } }]);
  const all = buildStarRailGachaVersion({ ...inputs, history, type: "all" })!;
  expect(all.gacha.versionData).toMatchObject([{ version: "全部统计", from: "", to: "", stats: { totalNum: 7 } }]);
  expect(all.gacha.totalStat).toMatchObject({ star5Num: 7, upNum: 5, avgUpNum: "1.4" });
});

test("累计、垫抽和旧占位不上时间轴，缺时间的真实五星仍可看到", () => {
  const mixed = structuredClone(history);
  mixed.pools.GachaType_AvatarUp.totalDraws = 129;
  mixed.pools.GachaType_AvatarUp.fiveStars[1]!.gacha_count = 72;
  Object.assign(mixed.pools.GachaType_AvatarUp, { pity: 17 });
  const model = buildStarRailGachaVersion({ ...inputs, history: mixed })!;
  expect(model.gacha.totalStat).toMatchObject({ totalNum: 131, star5Num: 6, unassignedDraws: 125, unassignedFiveStars: 0, w3Num: 0 });
  expect(model.gacha.versionData.map(({ stats }) => stats.totalNum)).toEqual([2, 3, 1]);
  mixed.pools.GachaType_AvatarUp.fiveStars.push(
    five("169154640000000078", "", "卡芙卡", true),
    Object.assign(five("lotus-11-1", "2023-08-10 13:00:01", "卡芙卡", true, "ItemType_Avatar", 30), { rank_type: "3" }),
  );
  const missing = buildStarRailGachaVersion({ ...inputs, history: mixed })!;
  expect(missing.gacha.totalStat).toMatchObject({ totalNum: 131, star5Num: 7, unassignedDraws: 125, unassignedFiveStars: 1, w3Num: 0 });
  expect(missing.gacha.versionData.at(-1)).toMatchObject({
    version: "未判定期次", from: "", to: "", unassigned: true, stats: { star5Num: 1 }, items: [{ id: "1005", num: 1 }],
  });
});

test("有确定的官方期次编号才认该期累计抽数，重叠时间按旧声明顺序", () => {
  const overlapping = [
    { version: "4.1", half: "中场", from: "2026-04-08 10:00:00", to: "2026-04-08 15:00:00", char5: ["卡芙卡"],
      gachaIds: { GachaType_AvatarUp: ["mapped", "ambiguous"] } },
    { version: "4.1", half: "下半", from: "2026-04-08 12:00:00", to: "2026-04-20 14:59:59", char5: ["罗刹"],
      gachaIds: { GachaType_AvatarUp: ["ambiguous"] } },
  ] satisfies StarRailGachaSchedulePeriod[];
  const result = buildStarRailGachaVersion({
    ...inputs, schedule: overlapping, type: "char", history: { uid, pools: { GachaType_AvatarUp: {
      totalDraws: 80, cardCounters: { mapped: 33, ambiguous: 47 }, fiveStars: [
        five("real", "2026-04-08 13:00:00", "卡芙卡", undefined),
        five("synthetic-id", "2026-04-08", "瓦尔特", false),
      ],
    } } },
  })!;
  expect(result.gacha.totalStat).toMatchObject({ totalNum: 80, unassignedDraws: 47, unassignedFiveStars: 1 });
  expect(result.gacha.versionData).toMatchObject([
    { half: "中场", stats: { star5Num: 1, c5UpNum: 1, totalNum: 33 } },
    { version: "未判定期次", stats: { star5Num: 1, totalNum: 1 } },
  ]);

  const noDoubleCount = buildStarRailGachaVersion({
    ...inputs, schedule: overlapping, type: "char", history: { uid, pools: { GachaType_AvatarUp: {
      totalDraws: 33, cardCounters: { mapped: 33 },
      fiveStars: [five("real-id-without-time", "", "瓦尔特", false)],
    } } },
  })!;
  expect(noDoubleCount.gacha.totalStat).toMatchObject({ totalNum: 33, unassignedDraws: 0, unassignedFiveStars: 1 });
});

test("空档返回无数据，只有累计的星铁历史可显示不附加虚假分期", () => {
  expect(buildStarRailGachaVersion({ ...inputs, history: null })).toBeUndefined();
  expect(buildStarRailGachaVersion({ ...inputs, history: { pools: { GachaType_AvatarUp: { totalDraws: 100 } } } })?.gacha)
    .toMatchObject({ versionData: [], totalStat: { totalNum: 100, unassignedDraws: 100, star5Num: 0 } });
  expect(() => buildStarRailGachaVersion({ ...inputs, history: { ...history, uid: "200000002" } })).toThrow("当前角色不一致");
});

test("有官方来源的长编号按 UTC 还原本条五星日期，其他来源及越界不归期", () => {
  const noon = Math.floor(Date.parse("2026-04-08T05:00:00Z") / 1000);
  const validId = `${noon}000000001`;
  const oldId = `${Math.floor(Date.parse("2022-04-08T05:00:00Z") / 1000)}000000004`;
  const windows = [
    { version: "4.1", half: "上午", from: "2026-04-08 00:00:00", to: "2026-04-08 11:59:59" },
    { version: "4.1", half: "下午", from: "2026-04-08 12:00:00", to: "2026-04-08 23:59:59" },
  ];
  const raw = { uid, source: "mihoyo_star_rail_gacha_miniapp", pools: { GachaType_AvatarUp: {
    totalDraws: 140, fiveStars: [
      five(validId, "", "卡芙卡", true, "ItemType_Avatar", 72),
      five(`${noon}000000002`, "2026-04-08 10:30:00", "瓦尔特", false),
      five(`${noon}000000003`, "2026-04-08", "罗刹", false),
      five(oldId, "", "符玄", true),
      five(String(noon), "", "符玄", false),
    ],
  } } };
  const model = buildStarRailGachaVersion({ ...inputs, history: raw, schedule: windows })!;
  expect(model.gacha.versionData.map(({ half, stats }) => [half, stats.totalNum])).toEqual([
    ["下午", 1], ["上午", 1], ["", 3],
  ]);
  expect(model.gacha.totalStat).toMatchObject({ totalNum: 140, unassignedDraws: 138, unassignedFiveStars: 3 });
  const other = buildStarRailGachaVersion({ ...inputs, history: { ...raw, source: "import" }, schedule: windows })!;
  expect(other.gacha.versionData.map(({ half, stats }) => [half, stats.totalNum])).toEqual([["上午", 1], ["", 4]]);
});
