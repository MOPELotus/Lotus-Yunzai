import { expect, test } from "bun:test";
import { parseGachaDisplaySettings } from "@lotus-yunzai/gacha/display-settings";
import type { GenshinGachaPool } from "../packages/hoyo-client/index.ts";
import { buildGenshinGachaDetail, resolveGenshinDetailPool } from "../plugins/genshin/gacha-detail.ts";
import { mergeGenshinGachaHistory } from "../plugins/genshin/gacha-history.ts";

const uid = "100000002";
const now = new Date("2026-11-19T08:00:00+08:00");
const regular = [{
  from: "2023-11-08 06:00:00", to: "2023-11-28 17:59:59",
  char5: ["芙宁娜"], weapon5: ["静水流涌之辉"],
}];
const mixed = [{
  from: "2024-03-13 06:00:00", to: "2024-04-02 17:59:59",
  char5: ["优菈", "可莉"], weapon5: ["松籁响起之时"],
}];

function sequence(pool: GenshinGachaPool, rows: readonly [string, number, "角色" | "武器"][], day = "2023-11-22") {
  return rows.map(([name, rank_type, item_type], index) => ({
    id: String(1700000000000000000n + BigInt(pool * 100 + rows.length - index)),
    gacha_type: String(pool), uid, name, rank_type: String(rank_type), item_type,
    time: `${day} 12:${String(24 - index).padStart(2, "0")}:00`,
  }));
}

const records = {
  301: sequence(301, [
    ["冷刃", 3, "武器"], ["芙宁娜", 5, "角色"], ["砂糖", 4, "角色"], ["冷刃", 3, "武器"],
    ["莫娜", 5, "角色"], ["西风剑", 4, "武器"], ["芙宁娜", 5, "角色"], ["班尼特", 4, "角色"],
  ]),
  302: sequence(302, [
    ["祭礼剑", 4, "武器"], ["静水流涌之辉", 5, "武器"], ["冷刃", 3, "武器"], ["天空之刃", 5, "武器"],
    ["祭礼剑", 4, "武器"], ["冷刃", 3, "武器"], ["静水流涌之辉", 5, "武器"], ["冷刃", 3, "武器"],
  ]),
  200: sequence(200, [
    ["冷刃", 3, "武器"], ["琴", 5, "角色"], ["班尼特", 4, "角色"], ["冷刃", 3, "武器"],
    ["莫娜", 5, "角色"], ["祭礼剑", 4, "武器"], ["天空之刃", 5, "武器"], ["砂糖", 4, "角色"],
  ]),
  500: sequence(500, [
    ["砂糖", 4, "角色"], ["优菈", 5, "角色"], ["冷刃", 3, "武器"], ["莫娜", 5, "角色"],
    ["班尼特", 4, "角色"], ["冷刃", 3, "武器"], ["可莉", 5, "角色"], ["冷刃", 3, "武器"],
  ], "2024-03-22"),
};

const ids: Record<string, string | number> = {
  芙宁娜: 10000089, 莫娜: 10000041, 天空之刃: 11502, 静水流涌之辉: "11513", 优菈: 10000051, 可莉: 10000029,
};
const options = {
  uid, records, face: { name: "旅者" }, now, resolvePool: resolveGenshinDetailPool(regular, mixed),
  resolveItem: (row: { name: string }) => ids[row.name] === undefined ? undefined :
    { id: ids[row.name]!, name: row.name, abbr: row.name, img: `fixture/${ids[row.name]}.webp` },
};

test("reproduces the character card's old stats, real four-stars, dates, guarantee and luck", () => {
  const model = buildGenshinGachaDetail(options)!;
  expect(model).toMatchObject({ uid, game: "gs", elem: "hydro", type: 301, poolName: "角色" });
  expect(model.gacha.stat).toEqual({
    allNum: 8, noFiveNum: 1, noFourNum: 2, fiveNum: 3, fourNum: 3, fiveAvg: "2.33", fourAvg: "2.00",
    wai: 1, isvalidNum: "3.50", weaponNum: 0, weaponFourNum: 1, upYs: "560",
  });
  expect(model.gacha.fiveLog).toEqual([
    { id: 888, isUp: true, count: 1, date: "11-19" },
    { id: 10000089, isUp: true, date: "11-22", count: 3, isBig: true, isNewPool: false },
    { id: 10000041, isUp: false, date: "11-22", count: 2, isNewPool: false },
    { id: 10000089, isUp: true, date: "11-22", count: 2, isNewPool: false },
  ]);
  expect(model.gacha.maxFour).toMatchObject({ count: 1, star: 4 });
  expect(model.gacha.luck).toMatchObject({
    isUpPool: true, percent: "100.0", upRate: 55, smallWin: 1, smallNum: 2, bigNum: 1, noWaiRate: "50.0",
  });
});

test("isolates weapon, standard and Chronicle pools, including a four-star on the last pull", () => {
  const weapon = buildGenshinGachaDetail({ ...options, pool: 302 })!;
  expect(weapon).toMatchObject({
    type: "weapon", poolName: "武器", gacha: { stat: { fourNum: 2, weaponFourNum: 2, noFourNum: 0, fourAvg: "4.00" },
      luck: { isUpPool: true, upRate: 75 }, maxFour: { name: "祭礼剑", count: 2 } },
  });
  expect(weapon.gacha.fiveLog[1]).toMatchObject({ id: "11513", isUp: true, isBig: true });

  const standard = buildGenshinGachaDetail({ ...options, pool: 200 })!;
  expect(standard).toMatchObject({ type: 200, poolName: "常驻", gacha: { stat: { wai: 3, fourNum: 3 }, luck: { isUpPool: false } } });

  const chronicle = buildGenshinGachaDetail({ ...options, pool: 500 })!;
  expect(chronicle).toMatchObject({
    type: 500, poolName: "集录", gacha: { stat: { wai: 1, noFourNum: 0, fourAvg: "4.00" },
      luck: { isUpPool: false, smallNum: 0, bigNum: 0 } },
  });
  expect(chronicle.gacha.fiveLog.slice(1).map(({ isUp, isBig, date }) => [isUp, isBig, date])).toEqual([
    [true, undefined, "03-22"], [false, undefined, "03-22"], [true, undefined, "03-22"],
  ]);
});

test("uses separate Chronicle dates, safe schedule boundaries, and explicit UP before inference", () => {
  const regularOverlap = { ...mixed[0]!, char5: ["莫娜"] };
  const invalidFinal = { ...mixed[0]!, from: "2026-11-04 06:00:00", to: "22026-11-24 17:59:59" };
  const resolvePool = resolveGenshinDetailPool([regularOverlap, invalidFinal], mixed);
  const chronicle = records[500].map((row) => row.name === "优菈" ? { ...row, is_up: false } : row);
  const result = buildGenshinGachaDetail({ ...options, records: { ...records, 500: chronicle }, resolvePool, pool: 500 })!;
  expect(result.gacha.fiveLog.slice(1).map(({ isUp }) => isUp)).toEqual([false, false, true]);
  const dated = { id: "1", star: 5 as const, itemType: "char" as const, name: "莫娜", pool: 301 as const, time: "" };
  expect(resolvePool({ ...dated, at: Date.parse("2024-03-20T00:00:00+08:00") })).toMatchObject({ isUp: true });
  expect(resolvePool({ ...dated, at: Date.parse("2024-03-13T06:00:00+08:00") })).toBeUndefined();
  expect(resolvePool({ ...dated, at: Date.parse("2026-11-19T06:00:00+08:00") })).toEqual({ isNewPool: true });
});

test("retains full stats for limits and pages, and only includes current pity on the first page", () => {
  const recent = buildGenshinGachaDetail({ ...options, maxRows: 2 })!;
  const first = buildGenshinGachaDetail({ ...options, maxRows: 2, page: 1 })!;
  const second = buildGenshinGachaDetail({ ...options, maxRows: 2, page: 2 })!;
  expect(recent.gacha).toMatchObject({ shownNum: 2, hiddenNum: 1 });
  expect(recent.gacha.fiveLog).toEqual(first.gacha.fiveLog);
  expect(first.pageInfo).toEqual({ page: 1, total: 2, from: 1, to: 2, count: 3 });
  expect(second.pageInfo).toEqual({ page: 2, total: 2, from: 3, to: 3, count: 3 });
  expect(second.gacha.fiveLog.map(({ id }) => id)).toEqual([10000089]);
  expect(first.gacha.stat).toEqual(second.gacha.stat);
  expect(buildGenshinGachaDetail({ ...options, maxRows: 0 })!.gacha.fiveLog).toHaveLength(4);
  expect(() => buildGenshinGachaDetail({ ...options, maxRows: 2, page: 3 })).toThrow("页码超出范围");
});

test("keeps unknown time and UP unknown, accepts old 400 and deduplicates precise legacy ids", () => {
  const oldRows = records[301].map((item, index) => index === 1 ? { ...item, gacha_type: "400", item_id: "10000089", time: "2023-02-31 10:00:00" } : item);
  const optionsWithoutSchedule = { uid, face: options.face, now, records: { 301: [...oldRows, oldRows[1]] } };
  const result = buildGenshinGachaDetail(optionsWithoutSchedule)!;
  expect(result.gacha.stat).toMatchObject({ allNum: 8, fiveNum: 3, fourNum: 3, wai: 0, upYs: "0" });
  expect(result.gacha.fiveLog[1]).toMatchObject({ id: "10000089", date: "", count: 3 });
  expect(result.gacha.fiveLog[1]!.isUp).toBeUndefined();
  expect(result.gacha.luck?.isUpPool).toBe(false);
  expect(buildGenshinGachaDetail({ ...options, records: {} })).toBeUndefined();
  expect(() => buildGenshinGachaDetail({ ...options, records: { 301: [{ ...oldRows[0], uid: "100000003" }] } })).toThrow("当前角色或卡池");
  expect(() => buildGenshinGachaDetail({ ...options, records: { 301: [{ ...oldRows[0], id: 1700000000000000000 }] } })).toThrow("编号无效");
});

test("keeps source order for same-second legacy pulls and descending IDs after a merge", () => {
  const [first, five, four, ...rest] = records[301];
  const time = first!.time;
  const legacy = [{ ...five!, time }, { ...four!, time }, first!, ...rest];
  const detail = (pool: unknown) => buildGenshinGachaDetail({ ...options, records: { 301: pool } })!.gacha;
  const old = detail(legacy);
  expect(old.stat).toMatchObject({ allNum: 8, noFiveNum: 0, noFourNum: 1 });
  expect(old.fiveLog[0]).toMatchObject({ id: 10000089, count: 4 });

  const written = mergeGenshinGachaHistory({ 301: legacy }, {
    uid, region: "cn_gf01", pools: [
      { type: 301, name: "角色活动祈愿", records: [] },
      { type: 302, name: "武器活动祈愿", records: [] },
      { type: 200, name: "常驻祈愿", records: [] },
      { type: 500, name: "集录祈愿", records: [] },
    ],
  }).records[301];
  expect(written.slice(0, 3).map(({ id }) => id)).toEqual([first!.id, five!.id, four!.id]);
  expect(detail(written).stat).toMatchObject({ allNum: 8, noFiveNum: 1, noFourNum: 2 });
  expect(detail(written).fiveLog[1]).toMatchObject({ id: 10000089, count: 3 });
  expect(detail([{ ...legacy[0], time: "" }, ...legacy.slice(1)]).stat)
    .toMatchObject({ allNum: 8, noFiveNum: 1, noFourNum: 2 });
});

test("uses configured ratings and pool model during pagination without changing record statistics", () => {
  const original = buildGenshinGachaDetail(options)!;
  const display = parseGachaDisplaySettings({ detailRows: 1, minSample: 0,
    levels: [{ min: 100, title: "自定义评级", desc: "自定义说明", color: "#123" }],
    models: { gs: { 301: { upRate: 0.7 } } } });
  const first = buildGenshinGachaDetail({ ...options, display, page: 1 })!;
  const final = buildGenshinGachaDetail({ ...options, display, page: 3 })!;
  expect(first.pageInfo).toMatchObject({ total: 3, from: 1, to: 1 });
  expect(final.pageInfo).toMatchObject({ total: 3, from: 3, to: 3 });
  expect(final.gacha.stat).toEqual(original.gacha.stat);
  expect(first.gacha.luck).toMatchObject({ title: "自定义评级", color: "#112233", upRate: 70, fewSample: false });
  expect(final.gacha.luck).toEqual(first.gacha.luck);
  const hidden = buildGenshinGachaDetail({ ...options, display: parseGachaDisplaySettings({ enabled: false, detailRows: 0 }) })!;
  expect(hidden.gacha.luck).toBeUndefined();
  expect(hidden.gacha.fiveLog).toEqual(original.gacha.fiveLog);
});
