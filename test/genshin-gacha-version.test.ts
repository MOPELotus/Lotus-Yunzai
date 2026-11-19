import { expect, test } from "bun:test";
import type { GenshinGachaPool } from "../packages/hoyo-client/index.ts";
import { buildGenshinGachaVersion, type GenshinGachaVersionOptions } from "../plugins/genshin/gacha-version.ts";

const uid = "100000002";
const schedule = [{
  version: "4.2", half: "上半", from: "2023-11-08 06:00:00", to: "2023-11-28 17:59:59",
  char5: ["芙宁娜", "白术"], weapon5: ["静水流涌之辉"],
}, {
  version: "4.1", half: "上半", from: "2023-09-27 06:00:00", to: "2023-10-17 17:59:59",
  name: "那维 / 胡桃", char5: ["那维莱特", "胡桃"], weapon5: ["万世流涌大典", "护摩之杖"],
}];
const mixedSchedule = [{
  version: "4.5", half: "上半", from: "2024-03-13 06:00:00", to: "2024-04-02 17:59:59",
  char5: ["优菈", "阿贝多", "可莉"], weapon5: ["苇海信标", "松籁响起之时"],
}];

function row(pool: GenshinGachaPool, id: number, name: string, rank: number, type: "角色" | "武器", time: string, extra = {}) {
  return { uid, gacha_type: String(pool), id: String(1700000000000000000n + BigInt(pool * 100 + id)),
    name, rank_type: String(rank), item_type: type, time, ...extra };
}

const November = "2023-11-22 12:24:00";
const earlier = "2023-10-12 12:24:00";
const March = "2024-03-22 12:24:00";
const records = {
  301: [
    row(301, 8, "冷刃", 3, "武器", November), row(301, 7, "芙宁娜", 5, "角色", November, { gacha_type: "400" }),
    row(301, 6, "砂糖", 4, "角色", November), row(301, 5, "莫娜", 5, "角色", November),
    row(301, 4, "西风剑", 4, "武器", November),
  ],
  302: [row(302, 1, "静水流涌之辉", 5, "武器", November), row(302, 2, "祭礼剑", 4, "武器", November)],
  200: [row(200, 1, "莫娜", 5, "角色", "无日期"), row(200, 2, "冷刃", 3, "武器", November)],
  500: [row(500, 1, "优菈", 5, "角色", March), row(500, 2, "松籁响起之时", 5, "武器", March),
    row(500, 3, "安柏", 4, "角色", March), row(500, 4, "冷刃", 3, "武器", March)],
};
const catalog = { 芙宁娜: [10000089, "芙芙"], 静水流涌之辉: ["11513", "静水"], 莫娜: [10000041, "莫娜"] } as const;
const base: GenshinGachaVersionOptions = {
  uid, records, face: { name: "旅行者" }, schedule, mixedSchedule,
  resolveItem({ name }) {
    const metadata = catalog[name as keyof typeof catalog];
    if (metadata) return { id: metadata[0], abbr: metadata[1], name, img: `${String(metadata[0])}.webp` };
  },
};

test("groups exact five, four and three-star pulls across character and weapon windows", () => {
  const model = buildGenshinGachaVersion(base)!;
  expect(model).toMatchObject({ uid, game: "gs", elem: "hydro", poolName: "抽卡", gacha: { isMix: false } });
  expect(model.gacha.totalStat).toEqual({
    w5Num: 1, w5UpNum: 1, c5Num: 2, c5UpNum: 1, c4Num: 1, w4Num: 2, w3Num: 1,
    upNum: 2, star5Num: 3, star4Num: 3, totalNum: 7, avgUpNum: "3.5", unassignedDraws: 0, unassignedFiveStars: 0,
  });
  const group = model.gacha.versionData[0]!;
  expect(group).toMatchObject({ version: "4.2", half: "上半", name: "芙芙 / 白术", from: "23-11-08", to: "23-11-28",
    upIds: { 10000089: "芙宁娜", 11513: "静水流涌之辉" } });
  expect(group.items.map(({ id, star, isUp }) => [id, star, isUp]).slice(0, 3)).toEqual([
    ["10000089", 5, 1], ["11513", 5, 1], ["10000041", 5, 0],
  ]);
  expect(group.items.filter(({ star }) => star < 5).map(({ star }) => star)).toEqual([4, 4, 4, 3]);
  expect(model.gacha.itemMap["10000089"]).toMatchObject({ type: "char", star: 5, name: "芙宁娜", count: 0 });
  expect(buildGenshinGachaVersion({ ...base, type: "char" })!.gacha.totalStat).toMatchObject({ totalNum: 5, c5UpNum: 1, w5UpNum: 0 });
  expect(buildGenshinGachaVersion({ ...base, type: "weapon" })!.gacha.totalStat).toMatchObject({ totalNum: 2, c5UpNum: 0, w5UpNum: 1 });
});

test("uses Chronicle schedules and keeps Standard and all-pool queries as single aggregate rows", () => {
  const mix = buildGenshinGachaVersion({ ...base, type: "mix" })!;
  expect(mix).toMatchObject({ poolName: "集录", gacha: { isMix: true, totalStat: { totalNum: 4, c5UpNum: 1, w5UpNum: 1 } } });
  expect(mix.gacha.versionData[0]).toMatchObject({
    version: "4.5", name: "优菈 / 阿贝多 / 可莉", from: "24-03-13", to: "24-04-02",
  });

  const standard = buildGenshinGachaVersion({ ...base, type: "normal" })!;
  expect(standard).toMatchObject({ poolName: "常驻", gacha: { totalStat: { totalNum: 2, upNum: 0 },
    versionData: [{ version: "常驻池", from: "", to: "" }] } });
  const all = buildGenshinGachaVersion({ ...base, type: "all" })!;
  expect(all).toMatchObject({ poolName: "全部", gacha: { isMix: false, totalStat: { totalNum: 13, star5Num: 6, star4Num: 4, w3Num: 3,
    upNum: 4, avgUpNum: "3.3" }, versionData: [{ version: "全部统计", from: "", to: "" }] } });
});

test("keeps unknown or out-of-window pulls independent and rejects false dates derived from ids", () => {
  const late = "2023-11-28 17:59:59";
  const result = buildGenshinGachaVersion({ ...base, type: "char", records: { 301: [
    ...records[301], records[301][1],
    row(301, 20, "芙宁娜", 5, "角色", "2023-11-22"),
    row(301, 21, "冷刃", 3, "武器", "2023-11-31 10:00:00"),
    row(301, 22, "西风剑", 4, "武器", late),
    row(301, 23, "莫娜", 5, "角色", "2023-11-23T16:30:00-08:00", { is_up: true }),
  ] } })!;
  expect(result.gacha.totalStat).toMatchObject({ totalNum: 9, w3Num: 2, star4Num: 3, star5Num: 4, c5UpNum: 2,
    unassignedDraws: 3, unassignedFiveStars: 1 });
  expect(result.gacha.versionData[0]).toMatchObject({ version: "4.2", stats: { totalNum: 6, c5UpNum: 2 } });
  expect(result.gacha.versionData[1]).toMatchObject({
    version: "未判定期次", unassigned: true, from: "", to: "", stats: { totalNum: 3, star5Num: 1, star4Num: 1, w3Num: 1 },
  });
  expect(result.gacha.versionData[1]!.upIds).toEqual({});
  expect(() => buildGenshinGachaVersion({ ...base, records: { 301: [{ ...records[301][0], id: 1700000000000000001 }] } }))
    .toThrow("编号无效");
});

test("keeps totals across reduced and forwarded pages with chronological periods", () => {
  const history = { ...records, 301: [...records[301], row(301, 10, "那维莱特", 5, "角色", earlier)] };
  const model = buildGenshinGachaVersion({ ...base, records: history, maxRows: 1 })!;
  const page1 = buildGenshinGachaVersion({ ...base, records: history, maxRows: 1, page: 1 })!;
  const page2 = buildGenshinGachaVersion({ ...base, records: history, maxRows: 1, page: 2 })!;
  expect(model.gacha).toMatchObject({ shownNum: 1, hiddenNum: 1, versionData: [{ version: "4.2" }] });
  expect(page1.pageInfo).toEqual({ page: 1, total: 2, from: 1, to: 1, count: 2 });
  expect(page2.pageInfo).toEqual({ page: 2, total: 2, from: 2, to: 2, count: 2 });
  expect(page2.gacha.versionData[0]).toMatchObject({ version: "4.1", name: "那维 / 胡桃", stats: { totalNum: 1, c5UpNum: 1 } });
  expect(page2.gacha.totalStat).toEqual(page1.gacha.totalStat);
  expect(buildGenshinGachaVersion({ ...base, records: history, maxRows: 0 })!.gacha.versionData).toHaveLength(2);
  expect(() => buildGenshinGachaVersion({ ...base, records: history, maxRows: 1, page: 3 })).toThrow("页码超出范围");
  expect(buildGenshinGachaVersion({ ...base, records: {} })).toBeUndefined();
});
