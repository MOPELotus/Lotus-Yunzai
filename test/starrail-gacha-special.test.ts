import { describe, expect, test } from "bun:test";
import { buildStarRailGachaSpecial, type StarRailGachaSpecialOptions } from "../plugins/starrail/gacha-special.ts";

const uid = "100000002";
const now = new Date("2026-04-20T16:00:00Z");
const avatar = "ItemType_Avatar";
const cone = "ItemType_Equipment";

function pull(id: string, name: string, item_type: string, count: number, fields = {}) {
  return { id, item: { name, item_type }, gacha_count: count, ...fields };
}

const pools = {
  GachaType_AvatarUp: { totalDraws: 11, fiveStars: [pull("role", "景元", avatar, 4, { time: "2025-07-12 12:00:00" })] },
  GachaType_CollabAvatarUp: {
    totalDraws: 21, pity: 1, fiveStars: [pull("linked-role", "Archer", avatar, 3, {
      is_up: false, time: "2025-07-22 12:00:00", gacha_id: "actual-banner-id",
    })],
  },
  GachaType_EquipmentUp: { totalDraws: 12, fiveStars: [pull("cone", "只需等待", cone, 7, { time: "2025-07-13 12:00:00" })] },
  GachaType_CollabEquipmentUp: {
    totalDraws: 22, fiveStars: [pull("linked-cone", "理想燃烧的地狱", cone, 3, { is_up: true, time: "2025-07-23 12:00:00" })],
  },
  GachaType_Standard: { totalDraws: 31, fiveStars: [pull("standard", "克拉拉", avatar, 11, { time: "2025-07-02 12:00:00" })] },
  GachaType_Newbie: { totalDraws: 32, pity: 1, fiveStars: [pull("newbie", "瓦尔特", avatar, 3, { time: "2025-07-03 12:00:00" })] },
};

function build(pool: StarRailGachaSpecialOptions["pool"], overrides: Partial<StarRailGachaSpecialOptions> = {}) {
  return buildStarRailGachaSpecial({ uid, history: { uid, pools }, pool, now, ...overrides });
}

describe("Star Rail special pool and cross-pool queries", () => {
  test("chooses exact pools 2, 21, and 22, and does not stretch an interval to cover the historical remainder", () => {
    const newbie = build("GachaType_Newbie")!.pools[0]!;
    expect(newbie).toMatchObject({
      type: 2, typeName: "新手", allNum: 32, pity: 1, fiveNum: 1, fiveAvg: 3, knownIntervals: 1, unknownDraws: 28,
      firstTime: "2025-07-03 12:00", lastTime: "2025-07-03 12:00",
      fiveLog: [{ name: "瓦尔特", num: 3, date: "2025-07-03 12:00" }],
    });
    expect(newbie.max).toBeUndefined();
    expect(newbie.fiveLog[0]!.isUp).toBeUndefined();

    const avatar = build("GachaType_CollabAvatarUp", {
      resolveItem(record) {
        expect(record).toMatchObject({ uid, gacha_type: "21", item_type: "角色", is_up: false });
        return { id: 1015, name: record.name, abbr: "弓兵", img: "meta-sr/character/Archer/imgs/face.webp" };
      },
    })!.pools[0]!;
    expect(avatar).toMatchObject({
      type: 21, typeName: "角色联动", allNum: 21, upNum: 0, notUpNum: 1, unknownUpNum: 0,
      fiveLog: [{
        name: "Archer", abbr: "弓兵", icon: "meta-sr/character/Archer/imgs/face.webp",
        num: 3, isUp: false, cardId: "actual-banner-id",
      }],
    });

    const equipment = build("GachaType_CollabEquipmentUp")!.pools[0]!;
    expect(equipment).toMatchObject({
      type: 22, typeName: "光锥联动", allNum: 22, max: 80, upNum: 1, notUpNum: 0,
      fiveLog: [{ name: "理想燃烧的地狱", itemType: "光锥", isUp: true }],
    });
  });

  test("keeps all six pools and independent date ranges, including history that only has beginner draws", () => {
    const all = build("all")!;
    expect(all.poolName).toBe("全部");
    expect(all.totalDraws).toBe(129);
    expect(all.fiveNum).toBe(6);
    expect(all.pools.map((pool) => [pool.type, pool.allNum, pool.firstTime, pool.max])).toEqual([
      [11, 11, "2025-07-12 12:00", 90], [21, 21, "2025-07-22 12:00", 90], [12, 12, "2025-07-13 12:00", 80],
      [22, 22, "2025-07-23 12:00", 80], [1, 31, "2025-07-02 12:00", 90], [2, 32, "2025-07-03 12:00", undefined],
    ]);
    const beginnerOnly = { pools: { GachaType_Newbie: { totalDraws: 20 } } };
    expect(build("all", { history: beginnerOnly })).toMatchObject({
      totalDraws: 20, fiveNum: 0, pools: [{ type: 2, allNum: 20, unknownDraws: 20, fiveLog: [] }],
    });
    expect(build("GachaType_CollabEquipmentUp", { history: beginnerOnly })).toBeUndefined();
    expect(build("all", { history: { pools: {} } })).toBeUndefined();
  });

  test("uses overlapping card counters only once and excludes artificial dates and rows", () => {
    const epoch = Date.parse("2025-07-18T17:20:00Z") / 1_000;
    const officialId = `${epoch}000000001`;
    const history = {
      source: "mihoyo_star_rail_gacha_miniapp",
      pools: {
        GachaType_CollabAvatarUp: {
          totalDraws: "18",
          cardCounters: { bannerA: 22, bannerB: 6 },
          cards: [{ gacha_id: "bannerA", total_count: 23 }, { gacha_id: "bannerB", total_count: 5 }],
          fiveStars: [
            { id: officialId, uuid: "same-id", item: null, gacha_count: 0, is_up: null },
            pull("", "Archer", avatar, 3, { uuid: "same-id", is_up: false }),
            pull(`${epoch}000000002`, "Saber", avatar, 0, { time: "1970-01-01 00:00:00" }),
            pull("invalid-date", "姬子", avatar, 0, { time: "2025-02-31 00:01:00" }),
            pull("lotus-21-1", "占位记录", cone, 20, { rank_type: "3", time: "2025-07-01 00:00:00" }),
            pull("lotus-21-2", "占位记录", cone, 17, { time: "2025-07-04 00:00:00" }),
            pull("four-star", "四星", avatar, 5, { rank_type: 4, time: "2025-07-01 00:00:00" }),
            pull("future", "未来", avatar, 0, { time: "2027-07-01 00:00:00" }),
          ],
        },
      },
    };
    const pool = build("GachaType_CollabAvatarUp", { history })!.pools[0]!;
    expect(pool).toMatchObject({
      allNum: 29, fiveNum: 4, knownIntervals: 1, unknownDraws: 23, fiveAvg: 3, unknownUpNum: 3,
      firstTime: "2025-07-19 01:20", lastTime: "2025-07-19 01:20",
    });
    expect(pool.fiveLog.map(({ num, date }) => [num, date])).toEqual([
      [3, "2025-07-19 01:20"], [undefined, undefined], [undefined, undefined], [undefined, undefined],
    ]);
    expect(pool.fiveLog[0]).toMatchObject({ id: officialId, name: "Archer", isUp: false });
    const otherSource = build("GachaType_CollabAvatarUp", { history: { ...history, source: "import" } })!.pools[0]!;
    expect(otherSource.firstTime).toBeUndefined();
    expect(otherSource.fiveLog.every((row) => row.date === undefined)).toBe(true);
  });

  test("shows explicit times in the server timezone and keeps dates independent from storage ordering", () => {
    const result = build("GachaType_Newbie", {
      history: { pools: { GachaType_Newbie: { fiveStars: [
        pull("1", "布洛妮娅", avatar, 0, { time: "2024-03-02T17:00:00+02:00" }),
        pull("2", "瓦尔特", avatar, 0, { legacy_time: "2024-03-01 01:00" }),
        pull("3", "克拉拉", avatar, 0, { time: "2024-03-03 01:00:00" }),
      ] } } },
    })!.pools[0]!;
    expect(result.firstTime).toBe("2024-03-01 01:00");
    expect(result.lastTime).toBe("2024-03-03 01:00");
    expect(result.fiveLog.map((row) => row.date)).toEqual(["2024-03-03 01:00", "2024-03-02 23:00", "2024-03-01 01:00"]);
    expect(result.fiveAvg).toBeUndefined();
    expect(result.pity).toBeUndefined();
  });

  test("pages real five-stars across pools, retains totals on each page and rejects unrelated history", () => {
    const row1 = pull("a", "瓦尔特", avatar, 3);
    const row2 = pull("b", "克拉拉", avatar, 5);
    const row3 = pull("c", "布洛妮娅", avatar, 8);
    const history = { uid, pools: { ...pools, GachaType_Newbie: { totalDraws: 32, fiveStars: [row1, row2, row3] } } };
    const first = build("all", { history, maxRows: 2, page: 1 })!;
    const second = build("all", { history, maxRows: 2, page: 2 })!;
    expect(first.pageInfo).toEqual({ page: 1, total: 2, from: 1, to: 2, count: 3 });
    expect(second.pageInfo).toEqual({ page: 2, total: 2, from: 3, to: 3, count: 3 });
    expect(first.pools.at(-1)).toMatchObject({ allNum: 32, fiveNum: 3, shownNum: 2, hiddenNum: 1 });
    expect(second.pools.at(-1)).toMatchObject({ allNum: 32, fiveNum: 3, shownNum: 1, hiddenNum: 2, fiveLog: [{ id: "c" }] });
    expect(second.pools[0]).toMatchObject({ type: 11, fiveNum: 1, fiveLog: [] });
    expect(second.totalDraws).toBe(first.totalDraws);
    expect(build("all", { history, maxRows: 2, page: 3 })).toBeUndefined();
    expect(() => build("all", { history: { ...history, uid: "100000003" } })).toThrow("与当前角色不一致");
    expect(() => build("all", { maxRows: 0 })).toThrow(RangeError);
  });
});
