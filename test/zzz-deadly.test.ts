import { expect, test } from "bun:test";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { GameRecordRequestError, HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { normalizeZzzDeadly, readZzzDeadly } from "../packages/hoyo-client/zzz-deadly.ts";

const identity = { uid: "12345678", region: "prod_qd_cn", scheduleType: 1 } as const;
const source = {
  qq: "42", profileId: 2, game: "zzz", revision: "fixture-revision",
  account: { cookie: "ltoken=fixture-cookie" }, device: { id: "fixture-device", fp: "fixture-fp" },
  role: { uid: identity.uid, region: identity.region, gameBiz: "nap_cn" },
} as ProfileRequestContext;
const art = "https://act-webstatic.mihoyo.com/fixture/deadly.png";
const start = { year: 2026, month: 11, day: 6, hour: 4, minute: 0, second: 0 };
const end = { ...start, day: 20 };
const boss = (name: string) => ({ name, icon: art, bg_icon: art, race_icon: art });
const room = {
  boss: [boss("复写体·猎血清道夫")], buffer: [{ name: "加成", icon: art, desc: "不进卡片" }],
  challenge_time: { ...start, day: 16, hour: 9 },
  score: 65000, star: 2, total_star: 3,
  avatar_list: [{ id: 1151, rarity: "A", rank: 2, role_square_url: art }, null],
  buddy: { id: 54001, rarity: "S", bangboo_rectangle_url: art },
};
const available = {
  has_data: true, start_time: start, end_time: end, zone_id: 41,
  total_score: 195000, total_star: 9, rank_percent: 123,
  list: [room, { ...room, score: 0, star: 0, boss: [boss("熔狱行者")] }],
};
const reply = (data: unknown) => Response.json({ retcode: 0, data });

test("危局读试炼及绝境同一期，保留旧房间顺序、分数、星级及独立百分比", () => {
  const record = normalizeZzzDeadly({ ...available, has_hard: true, hard_rank_percent: "0",
    nick_name: "隔离绳匠", avatar_icon: art, hard_list: [room] }, identity);
  expect(record).toMatchObject({
    status: "available", activityId: 41, nickname: "隔离绳匠", avatar: art,
    totalScore: 195000, totalStars: 9, trialRank: 123, hardRank: 0,
    period: { start: "2026-11-06 04:00:00", end: "2026-11-20 04:00:00" },
  });
  expect(record.trial.map(item => [item.name, item.score, item.stars])).toEqual([
    ["复写体·猎血清道夫", 65000, 2], ["熔狱行者", 0, 0],
  ]);
  expect(record.hard[0]).toMatchObject({
    name: "复写体·猎血清道夫", availableStars: 3, clearedAt: "2026-11-16 09:00:00",
    bossIcon: art, bossBackground: art, raceIcon: art, buffIcon: art, buffName: "加成",
    avatars: [{itemId:"1151", icon:art, rank:2, rarity:"A"}, undefined],
    buddy: {itemId:"54001", icon:art, rarity:"S"},
  });
});

test("危局兼容无绝境字段的旧记录、已授权但详情未刷新的汇总和官方空数据", () => {
  const original = normalizeZzzDeadly(available, identity);
  expect(original.hard).toEqual([]);
  expect(original.hardRank).toBeUndefined();
  expect(normalizeZzzDeadly({ ...available, list: [], total_score: 190000 }, identity))
    .toMatchObject({ status: "available", totalScore: 190000, trial: [], hard: [] });
  expect(normalizeZzzDeadly({ has_data: false }, identity))
    .toEqual({ ...identity, status: "empty", trial: [], hard: [] });
  expect(normalizeZzzDeadly({ ...available, has_hard: false, hard_list: [room], hard_rank_percent: 34 }, identity))
    .toMatchObject({ hard: [], hardRank: undefined });
});

test("危局拒绝错误身份、错期、反序日期和损坏队伍", () => {
  for (const fields of [
    { uid: "22345678" }, { server: "prod_gf_cn" }, { game_biz: "hkrpg_cn" }, { schedule_type: 2 },
    { start_time: end, end_time: start }, { list: "fixture" }, { list: [null] },
    { list: [{ ...room, star: 4 }] }, { list: [{ ...room, avatar_list: [0, 0, 0, 0] }] },
  ]) {
    expect(() => normalizeZzzDeadly({ ...available, ...fields }, identity)).toThrow(HoyoRequestError);
  }
});

test("危局新旧期只访问原 hadal_mem_detail_v2 与 uid/region 参数", async () => {
  for (const scheduleType of [1, 2] as const) {
    let verified = 0;
    const result = await readZzzDeadly(source, async (url, init) => {
      expect(url.href).toBe(`https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/hadal_mem_detail_v2?lang=zh-cn&uid=12345678&region=prod_qd_cn&schedule_type=${scheduleType}`);
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      const headers = new Headers(init.headers);
      expect(headers.get("cookie")).toBe("ltoken=fixture-cookie");
      expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
      expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
      return reply({ ...available, schedule_type: scheduleType });
    }, { scheduleType }, async () => { verified++; });
    expect(result.scheduleType).toBe(scheduleType);
    expect(verified).toBe(2);
  }
});

test("危局区分验证码和限频，取消与海外档案不会发送凭据", async () => {
  await expect(readZzzDeadly(source, async () => new Response(null, { headers: {"x-rpc-aigis": "fixture-challenge"} }),
    {scheduleType:1})).rejects.toMatchObject({ reason: "risk" });
  await expect(readZzzDeadly(source, async () => new Response(null, {status:429}),
    {scheduleType:1})).rejects.toBeInstanceOf(GameRecordRequestError);
  const network = async () => { throw new Error("fixture unexpectedly requested"); };
  const overseas = { ...source, role: { ...source.role, uid: "1000000001", region: "prod_gf_us", gameBiz: "nap_global" } };
  await expect(readZzzDeadly(overseas, network, {scheduleType:1})).rejects.toMatchObject({code:"invalid-input"});
  await expect(readZzzDeadly(source, network, {scheduleType:1, signal:AbortSignal.abort()}))
    .rejects.toMatchObject({code:"transport",message:expect.stringContaining("取消")});
});
