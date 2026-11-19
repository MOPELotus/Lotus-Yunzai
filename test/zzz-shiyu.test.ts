import { expect, test } from "bun:test";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { GameRecordRequestError, HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { normalizeZzzShiyu, readZzzShiyu } from "../packages/hoyo-client/zzz-shiyu.ts";

const identity = { uid: "12345678", region: "prod_gf_cn", scheduleType: 2 } as const;
const source = {
  qq: "42", profileId: 2, game: "zzz", revision: "fixture",
  account: { cookie: "ltoken=fixture-cookie" }, device: { id: "fixture-device", fp: "fixture-fp" },
  role: { uid: identity.uid, region: identity.region, gameBiz: "nap_cn" },
} as ProfileRequestContext;
const photo = "https://act-webstatic.mihoyo.com/role_square_avatar_1151.png";
const date = { year: 2026, month: 2, day: 6, hour: 4, minute: 0, second: 0 };
const fallbackDate = 1_770_322_400;
const team = {
  score: "0", rating: "S", challenge_time: fallbackDate,
  avatar_list: [{ id: 1151, rarity: "S", rank: 2, role_square_url: photo }, null],
  buddy: { id: 54001, rarity: "A", bangboo_rectangle_url: photo },
  monster_pic: photo, buffer: { title: " 惊雷浮光 ", text: "不进入卡片" }, battle_time: 0,
};
const layer = { challenge_time: date, rating: "A", layer_challenge_info_list: [team] };
const v2 = (data: object) => ({ hadal_ver: "v2", hadal_info_v2: data });
const response = (data: unknown) => Response.json({ retcode: 0, data });

test("式舆防卫战保留旧 v2 的第五至第一防线、队伍顺序和真实零分", () => {
  const record = normalizeZzzShiyu(v2({
    hadal_begin_time: date, hadal_end_time: { ...date, day: 20, hour: 3, minute: 59, second: 59 },
    brief: { score: 150000, rating: "S+", rank_percent: 97, battle_time: 318, challenge_time: date },
    first_layer_detail: layer, third_layer_detail: layer, fourth_layer_detail: layer,
    fitfh_layer_detail: { layer_challenge_info_list: [team, { ...team, score: 50000 }] },
  }), identity);
  expect(record.status).toBe("available");
  expect(record.period).toEqual({ start: "2026-02-06 04:00:00", end: "2026-02-20 03:59:59" });
  expect(record.overall).toEqual({
    score: 150000, rating: "S+", rankBasisPoints: 97, battleTime: 318, challengeTime: "2026-02-06 04:00:00",
  });
  expect(record.layers.map(item => item.number)).toEqual([5, 4, 3, 1]);
  expect(record.layers[0]?.teams.map(item => item.score)).toEqual([0, 50000]);
  expect(record.layers[0]?.teams[0]).toMatchObject({
    challengeTime: new Date((fallbackDate + 28800) * 1000).toISOString().slice(0, 19).replace("T", " "),
    battleTime: 0, rating: "S", buff: "惊雷浮光", monster: photo,
    avatars: [{ itemId: "1151", rarity: "S", rank: 2, icon: photo }, undefined],
    buddy: { itemId: "54001", rarity: "A", icon: photo },
  });
  expect(record.layers[1]).toMatchObject({ rating: "A", challengeTime: "2026-02-06 04:00:00" });
});

test("式舆区分空数据、旧版与无效战绩，并兼容新版第五防线字段拼写", () => {
  expect(normalizeZzzShiyu({ hadal_ver: "v1" }, identity).status).toBe("older-format");
  expect(normalizeZzzShiyu({ hadal_ver: "v2", hadal_info_v2: null }, identity).status).toBe("empty");
  expect(normalizeZzzShiyu(v2({ fitfh_layer_detail: { layer_challenge_info_list: [] } }), identity).status).toBe("empty");
  expect(normalizeZzzShiyu(v2({ fifth_layer_detail: layer }), identity).layers[0]?.number).toBe(5);
  for (const bad of [
    {}, v2({ fitfh_layer_detail: { layer_challenge_info_list: [null] } }),
    v2({ fitfh_layer_detail: { layer_challenge_info_list: "malformed" } }),
    v2({ first_layer_detail: { layer_challenge_info_list: [team, team, team] } }),
    v2({ hadal_begin_time: { ...date, day: 8 }, hadal_end_time: date }),
  ]) {
    expect(() => normalizeZzzShiyu(bad, identity)).toThrow(HoyoRequestError);
  }
});

test("式舆拒绝错绑 UID、游戏、区服或查询周期，不回传上游正文", () => {
  for (const info of [{ uid: "22345678" }, { server: "prod_qd_cn" }, { game_biz: "hkrpg_cn" }, { schedule_type: 1 }]) {
    for (const data of [v2(info), { hadal_ver: "v2", ...info }]) {
      expect(() => normalizeZzzShiyu(data, identity)).toThrow(/不一致/u);
    }
  }
});

test("式舆本期与上期使用同档案 Cookie 和设备，请求仅走原官方国服路由", async () => {
  for (const scheduleType of [1, 2] as const) {
    let verifies = 0;
    const result = await readZzzShiyu(source, async (url, init) => {
      expect(url.href).toBe(`https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/hadal_info_v2?lang=zh-cn&role_id=12345678&server=prod_gf_cn&schedule_type=${scheduleType}`);
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      const headers = new Headers(init.headers);
      expect(headers.get("cookie")).toBe("ltoken=fixture-cookie");
      expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
      expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
      return response(v2({ schedule_type: scheduleType, first_layer_detail: layer }));
    }, { scheduleType }, async () => { verifies++; });
    expect(result.scheduleType).toBe(scheduleType);
    expect(verifies).toBe(2);
  }
});

test("式舆风控和限流分开反馈，拒绝向非国服战绩发送国服档案", async () => {
  await expect(readZzzShiyu(source, async () => Response.json({ retcode: 1034, message: "challenge" }),
    { scheduleType: 1 })).rejects.toMatchObject({ reason: "risk" });
  await expect(readZzzShiyu(source, async () => new Response(null, { status: 429 }),
    { scheduleType: 1 })).rejects.toBeInstanceOf(GameRecordRequestError);
  const overseas = { ...source, role: { ...source.role, uid: "1000000001", region: "prod_gf_us", gameBiz: "nap_global" } };
  let requested = 0;
  await expect(readZzzShiyu(overseas, async () => { requested++; return response({}); }, { scheduleType: 1 }))
    .rejects.toMatchObject({ code: "invalid-input" });
  expect(requested).toBe(0);
});
