import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { normalizeZzzZenkov, readZzzZenkov } from "../packages/hoyo-client/zzz-zenkov.ts";

const identity = { uid: "12345678", region: "prod_gf_cn" };
const source = {
  qq: "42", profileId: 1, game: "zzz", revision: "fixture-revision",
  account: { cookie: "cookie_token=fixture-cookie" }, device: { id: "fixture-device", fp: "fixture-fp" },
  role: { ...identity, gameBiz: "nap_cn" },
} as ProfileRequestContext;
const icon = "https://act-webstatic.mihoyo.com/fixture/loot.png";

test("迷宫概况保留赛季、排行单位、货币精度、地图锁态及收藏原顺序", () => {
  const data = { season_unlock: false, season_data: { cur_season_id: "3", season_level: 0, refresh_time: 0,
    season_quest: { cur_quest: 0, max_quest: 4 } },
    refresh_time: 3600, collect_total_value: "999999123456789012", big_red_num: 0, max_rank: 130, is_show_percent: true,
    map_list: [{ map_name: "合成地图", hell_unlock: true, leave_percent: 0, max_price: "0", max_rank: 400, is_show_percent: false },
      { map_name: "合成未解锁", hell_unlock: false }],
    collection_data: { medal_data: { cur: 0, total: 2, list: [{ name: "甲", unlock: false, medal_icon: icon }] },
      goods_data: { cur: 1, total: 9, list: [{ name: "乙", number: 1, goods_icon: icon }] } } };
  expect(normalizeZzzZenkov(data, identity, "summary")).toMatchObject({ status: "available", seasonUnlocked: false,
    season: { id: 3, level: 0, remaining: 0, quest: { current: 0, total: 4 } }, weeklyRemaining: 3600,
    zGrade: 0, carryValue: "999999123456789012", rank: { value: 130, percent: true },
    maps: [{ unlocked: true, evacuation: 0, price: "0", rank: { value: 400, percent: false } },
      { unlocked: false, evacuation: undefined, price: undefined, rank: undefined }],
    medals: { current: 0, total: 2, items: [{ name: "甲", unlocked: false, icon }] },
    goods: { current: 1, total: 9, items: [{ name: "乙", count: 1, icon }] },
  });
});

test("迷宫详细战绩保留实际零、失败、未知、时间与物品数据", () => {
  const record = { map_name: "地图乙", start_time: { year: 2026, month: 11, day: 20, hour: 4 },
    challenge_time: { hour: 0, minute: 0, second: 0 }, difficult: "Hell", is_success: false, material_total_value: 0,
    avatar_list: [{ id: 1011, rank: 3, role_square_url: icon }],
    item_list: [{ name: "合成收获", rarity: 5, icon_url: icon, price: "01234" }] };
  expect(normalizeZzzZenkov({ map_list: [], record_list: [record, {}] }, identity, "detail")).toMatchObject({
    maps: [], kind: "detail", records: [{ map: "地图乙", started: "2026-11-20 04:00:00", seconds: 0, difficulty: "高危",
      success: false, value: "0", avatars: [{ itemId: "1011", rank: 3, icon }], loot: [{ rarity: 5, icon, price: "1234" }] },
      { started: undefined, success: undefined, value: undefined, difficulty: undefined, seconds: undefined }],
  });
  expect(normalizeZzzZenkov({ map_list: [], record_list: [] }, identity, "detail").status).toBe("empty");
  const large = { record_list: Array.from({ length: 41 }, (_, index) => ({
    map_name: `地图 ${index + 1}`, item_list: Array.from({ length: 19 }, () => ({})),
  })) };
  const first = normalizeZzzZenkov(large, identity, "detail");
  expect(first).toMatchObject({ totalRecords: 41, firstPage: 1, pageCount: 7,
    records: Array.from({ length: 18 }, (_, index) => ({ map: `地图 ${index + 1}`, hiddenLoot: 1 })) });
  expect(normalizeZzzZenkov(large, identity, "detail", 4)).toMatchObject({ firstPage: 4,
    records: Array.from({ length: 6 }, (_, index) => ({ map: `地图 ${index + 19}` })) });
  expect(normalizeZzzZenkov(large, identity, "detail", 7)).toMatchObject({ firstPage: 7,
    records: Array.from({ length: 5 }, (_, index) => ({ map: `地图 ${index + 37}` })) });
  expect(normalizeZzzZenkov(large, identity, "detail", 8)).toMatchObject({ firstPage: 8, pageCount: 7, records: [] });
  for (const bad of [{ role_id: 12345679 }, { region: "prod_qd_cn" }, { map_list: [{}], max_rank: 10001, is_show_percent: true },
    { record_list: [{ start_time: { year: 2026, month: 2, day: 31 } }] }]) {
    expect(() => normalizeZzzZenkov(bad, identity, "detail")).toThrow(HoyoRequestError);
  }
});

test("两条原迷宫 GET 各签 lang、uid、region，使用同档设备且不加期次参数", async () => {
  const paths: string[] = [];
  let guarded = 0;
  for (const kind of ["summary", "detail"] as const) {
    const result = await readZzzZenkov(source, async (url, init) => {
      paths.push(url.pathname);
      expect(url.hostname).toBe("api-takumi-record.mihoyo.com");
      expect(url.search).toBe("?lang=zh-cn&uid=12345678&region=prod_gf_cn");
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
      expect(init.body).toBeUndefined();
      const headers = new Headers(init.headers);
      expect(headers.get("Cookie")).toBe("cookie_token=fixture-cookie");
      expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
      expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
      const [t, r, hash] = headers.get("DS")!.split(",");
      expect(hash).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${t}&r=${r}&b=&q=${url.search.slice(1)}`).digest("hex"));
      return Response.json({ retcode: 0, data: null });
    }, { kind }, async () => { guarded++; });
    expect(result.status).toBe("empty");
  }
  expect(paths).toEqual(["/event/game_record_zzz/api/zzz/zenkov_abstract_info", "/event/game_record_zzz/api/zzz/zenkov_detail"]);
  expect(guarded).toBe(4);
});
