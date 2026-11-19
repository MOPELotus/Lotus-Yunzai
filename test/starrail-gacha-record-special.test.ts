import { expect, test } from "bun:test";
import { buildStarRailRecordSpecial, renderStarRailRecordSpecial } from "../plugins/starrail/gacha-record-special.ts";
import type { StarRailRecordDraw } from "../plugins/starrail/gacha-record-source.ts";

const uid = "100000002";
const epoch = Date.parse("2025-07-18T12:00:00+08:00");

function draw(id: string, pool: StarRailRecordDraw["pool"], rank: StarRailRecordDraw["rank"],
  minutes = 0): StarRailRecordDraw {
  return { id, gachaId: pool + "01", pool, at: epoch + minutes * 60_000, rank,
    item: { id: "1014", name: "Saber", abbr: "Saber", img: "/meta-sr/character/Saber/imgs/face.webp", kind: "char" } };
}

test("星铁逐抽全池显示保留六池顺序，分页不改变原始记录和全部指标", () => {
  const draws = [
    draw("1", "1", 3), draw("2", "2", 3), draw("3", "22", 5),
    draw("4", "12", 5), draw("5", "21", 5), draw("6", "11", 5),
    draw("7", "11", 3, 1), draw("8", "11", 5, 2), draw("9", "11", 5, 3),
  ];
  const options = { uid, draws, pool: "all", maxRows: 2 } as const;
  const first = buildStarRailRecordSpecial({ ...options, page: 1 });
  const second = buildStarRailRecordSpecial({ ...options, page: 2 });
  if (!first || !second) throw new Error("星铁逐抽档案缺少分页。");
  expect(first).toMatchObject({ poolName: "全部", totalDraws: 9, fiveNum: 6,
    pageInfo: { page: 1, total: 2, from: 1, to: 2, count: 3 } });
  expect(first.pools.map(({ type }) => type)).toEqual([11, 21, 12, 22, 1, 2]);
  expect(first.pools[0]).toMatchObject({
    allNum: 4, fiveNum: 3, shownNum: 2, hiddenNum: 1, firstTime: "2025-07-18 12:00", lastTime: "2025-07-18 12:03",
    fiveLog: [{ id: "9", num: 1 }, { id: "8", num: 2 }],
  });
  expect(second.pageInfo).toEqual({ page: 2, total: 2, from: 3, to: 3, count: 3 });
  expect(second.pools[0]?.fiveLog).toEqual([
    { id: "6", name: "Saber", abbr: "Saber", icon: "/meta-sr/character/Saber/imgs/face.webp", date: "2025-07-18 12:00" },
  ]);
  expect(second.pools[0]?.metrics).toEqual(first.pools[0]?.metrics);
  expect(first.pools[0]?.metrics[0]?.map(([, value]) => value)).toEqual([0, 3, 1.5, 0, 2]);
  expect(first.pools[0]?.metrics[1]?.map(([, value]) => value)).toEqual([2, 0, 0, 3, 1]);
  expect(buildStarRailRecordSpecial({ ...options, page: 3 })).toBeUndefined();
  expect(draws.map(({ id }) => id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
});

test("星铁逐抽跳过未知出金间隔，只有确证的联动五星才标 UP", () => {
  const resolverCalls: string[] = [];
  const model = buildStarRailRecordSpecial({ uid, pool: "all",
    draws: [
      draw("7", "21", 5), draw("12", "21", 3), draw("8", "21", 4), draw("13", "21", undefined),
      draw("9", "21", 5), draw("10", "21", undefined), draw("11", "21", 5),
      draw("14", "2", 5), draw("15", "2", 4), draw("16", "22", 3),
    ],
    resolvePool(draw) {
      resolverCalls.push(draw.id);
      if (draw.id === "7") return { isUp: true };
      if (draw.id === "9") return { isUp: false };
    },
  });
  if (!model) throw new Error("缺少星铁逐抽模型。");
  expect(resolverCalls).toEqual(["7", "9", "11"]);
  const [collab, lightCone, newbie] = model.pools;
  expect(collab?.fiveLog.map(({ id, isUp, num }) => [id, isUp, num])).toEqual([
    ["11", undefined, undefined], ["9", false, 2], ["7", true, undefined],
  ]);
  expect(collab?.metrics[0]?.map(([, value]) => value)).toEqual([undefined, 3, 2, 1, 2]);
  expect(collab?.metrics[1]?.map(([, value]) => value)).toEqual([1, 2, 1, 1, 2]);
  expect(lightCone?.fiveNum).toBe(0);
  expect(lightCone?.metrics[0]?.[0]?.[1]).toBeUndefined();
  expect(newbie?.fiveLog[0]?.isUp).toBeUndefined();
  expect(newbie?.metrics[0]?.map(([, value]) => value)).toEqual([1, 1, undefined, undefined, undefined]);
  expect(newbie?.metrics[1]?.[3]?.[1]).toBeUndefined();
});

test("星铁逐抽新手卡仅在该池有记录时渲染，并沿用共享渲染校验", async () => {
  const draws = [draw("1", "2", 3)];
  expect(buildStarRailRecordSpecial({ uid, draws, pool: "GachaType_CollabAvatarUp" })).toBeUndefined();
  expect(() => buildStarRailRecordSpecial({ uid, draws, pool: "all", maxRows: 0 })).toThrow(RangeError);
  const model = buildStarRailRecordSpecial({ uid, draws, pool: "GachaType_Newbie", page: 1 });
  if (!model) throw new Error("有真实抽数的新手池应可展示。");
  expect(model).toMatchObject({ poolName: "新手", totalDraws: 1, fiveNum: 0,
    pageInfo: { page: 1, total: 1, from: 0, to: 0, count: 0 }, pools: [{ type: 2, fiveLog: [] }] });
  await expect(renderStarRailRecordSpecial(model, { scale: 0 })).rejects.toThrow(RangeError);
});
