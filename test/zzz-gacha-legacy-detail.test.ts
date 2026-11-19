import { expect, test } from "bun:test";
import { zzzTuningPools } from "@lotus-yunzai/hoyo-client";
import { buildZzzLegacyDetail } from "../plugins/zzz/gacha-legacy-detail.ts";
import type { ZzzLegacyGachaDraw, ZzzLegacyGachaPool } from "../plugins/zzz/gacha-legacy.ts";

const uid = "1300000002";
const latest = "2026-11-01 01:05:00";
const earliest = "2026-11-01 01:43:00";
const player = { nickname: "海外绳匠", avatar: "avatar-key" };

function draw(index: number, extra: Partial<ZzzLegacyGachaDraw> = {}): ZzzLegacyGachaDraw {
  return {
    id: (8000000000000000000n - BigInt(index)).toString(), itemId: "12001", count: 1,
    gachaId: "9001", time: latest, name: "Lunar", lang: "en-us", itemType: "音擎", rank: "2",
    ...extra,
  };
}

function pools(entries: Partial<Record<ZzzLegacyGachaPool["type"], readonly ZzzLegacyGachaDraw[]>>) {
  return Object.entries(zzzTuningPools).map(([key, { name, id }]): ZzzLegacyGachaPool => {
    const type = key as ZzzLegacyGachaPool["type"];
    return { type, name, gachaType: String(id) as ZzzLegacyGachaPool["gachaType"], records: entries[type] ?? [] };
  }).reverse();
}

test("海外六频段卡用档案行绘制闭合区间并标记最旧档案下界", () => {
  const character = Array.from({ length: 92 }, (_, index) => {
    if (index === 2) return draw(index, { itemId: "1191", name: "Ellen", itemType: "代理人", rank: "4" });
    if (index === 83) return draw(index, { itemId: "1141", name: "Lycaon", itemType: "代理人", rank: "4" });
    if (index === 91) return draw(index, { count: 3, time: earliest });
    return draw(index);
  });
  const usedIcons: string[] = [];
  const model = buildZzzLegacyDetail({
    stats: { uid, pools: pools({ GACHA_TYPE_CHARACTER_UP: character }) },
    player,
    resolveIcon(record) {
      usedIcons.push(record.itemId);
      if (record.itemId === "1191") return "ellen-key";
    },
  });
  expect(model).toMatchObject({ uid, ...player });
  expect(model.data.map(({ name }) => name)).toEqual([
    "独家频段", "独家重映", "音擎频段", "音擎回响", "常驻频段", "邦布频段",
  ]);
  const active = model.data[0]!;
  expect(active).toMatchObject({
    totalCount: 92, fiveStars: 2, lastFive: 2, avgFive: "81.0", avgUp: "-", noWai: "-",
    timeRange: `${latest} ～ ${earliest}`, avgUpEstimated: false, noWaiEstimated: false, upCount: 0,
  });
  expect(active.list.map(({ totalCount, color, isUp, square_icon }) => [totalCount, color, isUp, square_icon])).toEqual([
    ["81", "rgb(255, 20, 20)", false, "ellen-key"], ["≥9", "white", false, ""],
  ]);
  expect(usedIcons).toEqual(["1191", "1141"]);
});

test("无档案抽数、有抽数但无S、恰好有一个S的频段有不同的统计", () => {
  const model = buildZzzLegacyDetail({
    stats: { uid, pools: pools({
      GACHA_TYPE_PERMANENT: [draw(0), draw(1, { rank: "3", time: earliest })],
      GACHA_TYPE_BANGBOO: [draw(0, { rank: "4", itemType: "邦布", itemId: "54001" })],
    }) },
    player: { nickname: player.nickname },
  });
  expect(model.data[0]).toMatchObject({
    timeRange: "还没有抽卡", totalCount: 0, lastFive: "-", pityLabel: "暂无抽卡记录", avgFive: "-", list: [],
  });
  expect(model.data[4]).toMatchObject({
    timeRange: `${latest} ～ ${earliest}`, totalCount: 2, lastFive: "-", pityLabel: "档案内未出S级", avgFive: "-", list: [],
  });
  expect(model.data[5]).toMatchObject({
    totalCount: 1, lastFive: 0, avgFive: "-", avgUp: "-", noWai: "-",
    list: [{ isUp: false, totalCount: "≥1" }],
  });
});
