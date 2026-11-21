import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { normalizeZzzVoidFront, readZzzVoidFront } from "../packages/hoyo-client/zzz-void-front.ts";

const identity = { uid: "12345678", region: "prod_gf_cn", scheduleType: 1 } as const;
const source = {
  qq: "42", profileId: 2, game: "zzz", revision: "fixture-revision",
  account: { cookie: "cookie_token=fixture-cookie" }, device: { id: "fixture-device", fp: "fixture-fp" },
  role: { uid: identity.uid, region: identity.region, gameBiz: "nap_cn" },
} as ProfileRequestContext;
const date = { year: 2026, month: 11, day: 1, hour: 4 };
const art = "https://act-webstatic.mihoyo.com/fixture/void.png";
const round = { name: "合成子关一", star: "a", buffer: { name: "合成增益", icon: art },
  avatar_list: [{ id: 1011, rank: 0, rarity: "A", role_square_url: art }, null],
  buddy: { id: 54001, rarity: "S", bangboo_rectangle_url: art } };
const last = { ...round, name: "最终关", star: "SP", score: 182000, max_score: 182000, score_ratio: "125%",
  challenge_time: { ...date, day: 4, second: 0 }, sub_challenge_record: [round, { name: "合成未知子关" }] };
const brief = { start_time: date, end_time: { ...date, day: 15 }, total_score: 400001, max_score: 663000,
  rank_percent: 123, ending_record_name: "合成结局", ending_record_bg_pic: art };
const detail = {
  void_front_battle_abstract_info_brief: brief,
  boss_challenge_record: { boss_info: { name: "合成首领", icon: art }, main_challenge_record: last },
  main_challenge_record_list: [{ name: "合成普通关", score: 0, score_ratio: 0, star: "B", avatar_list: [] }],
};
const fixture = { uid: identity.uid, region: identity.region, void_front_battle_detail: detail };

test("临界推演保留结局、百分位、末关队伍及两层子关顺序", () => {
  const record = normalizeZzzVoidFront(fixture, identity);
  expect(record).toMatchObject({
    status: "available", start: "2026-11-01 04:00:00", end: "2026-11-15 04:00:00", totalScore: 400001,
    maxScore: 663000, rank: 123, ending: "合成结局", endingArtwork: art,
    finalStage: { name: "合成首领", bossIcon: art, score: 182000, maxScore: 182000, rating: "SP", ratio: "125%",
      clearedAt: "2026-11-04 04:00:00", buffName: "合成增益", buffIcon: art,
      avatars: [{ itemId: "1011", rank: 0, icon: art, rarity: "A" }, undefined],
      buddy: { itemId: "54001", rarity: "S", icon: art } },
    stages: [{ name: "合成普通关", score: 0, ratio: "0", rating: "B", rounds: [] }],
  });
  expect(record.finalStage?.rounds.map(row => [row.name, row.rating])).toEqual([
    ["合成子关一", "A"], ["合成未知子关", undefined],
  ]);
});

test("临界推演区分空数据、真实零值和未知字段", () => {
  for (const input of [{}, { void_front_battle_detail: null }, { void_front_battle_detail: {} }]) {
    expect(normalizeZzzVoidFront(input, identity)).toEqual({ ...identity, status: "empty", stages: [] });
  }
  const partial = normalizeZzzVoidFront({ void_front_battle_detail: {
    void_front_battle_abstract_info_brief: { total_score: 0, rank_percent: 0 },
    boss_challenge_record: { boss_info: { name: "等待记录" } },
    main_challenge_record_list: [{ name: "合成未知关", star: "UNKNOWN" }],
  } }, identity);
  expect(partial).toMatchObject({ status: "available", totalScore: 0, rank: 0 });
  expect([partial.start, partial.end, partial.finalStage, partial.stages[0]?.score, partial.stages[0]?.rating])
    .toEqual(Array(5).fill(undefined));
});

test("临界推演校验内外层身份、期次、坏日期和有限队伍", () => {
  for (const input of [
    { ...fixture, uid: "23456789" }, { ...fixture, region: "prod_qd_cn" },
    { void_front_battle_detail: { ...detail, role_id: 23456789 } },
    { void_front_battle_detail: { ...detail, schedule_type: 2 } },
    { void_front_battle_detail: { ...detail, void_front_battle_abstract_info_brief: { ...brief, end_time: date } } },
    { void_front_battle_detail: { ...detail, void_front_battle_abstract_info_brief: { ...brief, start_time: { ...date, day: 31 } } } },
    { void_front_battle_detail: { main_challenge_record_list: [null] } },
    { void_front_battle_detail: { main_challenge_record_list: [{ avatar_list: [null, null, null, null] }] } },
    { void_front_battle_detail: { main_challenge_record_list: [{ sub_challenge_record: "invalid" }] } },
    { void_front_battle_detail: { void_front_battle_abstract_info_brief: { rank_percent: 10001 } } },
  ]) expect(() => normalizeZzzVoidFront(input, identity)).toThrow(HoyoRequestError);
});

test("临界推演本期、上期只发旧详情 GET 并按完全相同查询签名", async () => {
  for (const scheduleType of [1, 2] as const) {
    const query = `lang=zh-cn&uid=${identity.uid}&region=${identity.region}&schedule_type=${scheduleType}`;
    let guarded = 0;
    const result = await readZzzVoidFront(source, async (url, init) => {
      expect(url.href).toBe(`https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/void_front_battle_period_detail?${query}`);
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
      expect(init.body).toBeUndefined();
      const headers = new Headers(init.headers);
      expect(headers.get("Cookie")).toBe("cookie_token=fixture-cookie");
      expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
      expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
      const [t, r, hash] = headers.get("DS")!.split(",");
      expect(hash).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${t}&r=${r}&b=&q=${query}`).digest("hex"));
      return Response.json({ retcode: 0, data: { ...fixture, schedule_type: scheduleType } });
    }, { scheduleType }, async () => { guarded++; });
    expect(result.scheduleType).toBe(scheduleType);
    expect(guarded).toBe(2);
  }
  const unreachable = async () => { throw new Error("此合成请求不应发送。"); };
  const overseas = { ...source, role: { ...source.role, uid: "1300000002", region: "prod_gf_jp", gameBiz: "nap_global" } };
  await expect(readZzzVoidFront(overseas, unreachable, { scheduleType: 1 })).rejects.toMatchObject({ code: "invalid-input" });
  await expect(readZzzVoidFront(source, unreachable, { scheduleType: 3 as 1 })).rejects.toMatchObject({ code: "invalid-input" });
});
