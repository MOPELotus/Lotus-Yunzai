import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { normalizeZzzClimbingTower, readZzzClimbingTower } from "../packages/hoyo-client/zzz-climbing-tower.ts";

const identity = { uid: "12345678", region: "prod_gf_cn" };
const source = {
  qq: "42", profileId: 1, game: "zzz", revision: "fixture-revision",
  account: { cookie: "cookie_token=fixture-cookie" }, device: { id: "fixture-device", fp: "fixture-fp" },
  role: { ...identity, gameBiz: "nap_cn" },
} as ProfileRequestContext;

test("爬塔保留旧四赛季分支、真实零值、未知数据与前三名次序", () => {
  const medal = "https://act-webstatic.mihoyo.com/fixture/medal.png";
  const fixture = {
    climbing_tower_s1: { medal_icon: medal, climbing_tower_layer: "63" },
    climbing_tower_s2: { climbing_tower_layer: null, floor_mvp_num: 0 },
    climbing_tower_s3: { layer_info: { climbing_tower_layer: 0, total_score: 0 }, mvp_info: { rank_percent: "0" } },
    climbing_tower_s4: { layer_info: { total_score: 14032 }, mvp_info: { floor_mvp_num: 62, rank_percent: 999 },
      display_avatar_rank_list: [
        { name: "甲", id: 1011, rarity: "S", score: 0, rank_percent: 0 },
        { name: "乙", id: 1021, rarity: "A", score: 112, rank_percent: 876 },
        { name: "丙", icon: medal },
        { name: "丁", score: 10000 },
      ] },
  };
  const result = normalizeZzzClimbingTower(fixture, identity);
  expect(result).toMatchObject({ status: "available", seasons: [
    { number: 1, layer: 63, medal, mvp: undefined, score: undefined, avatars: [] },
    { number: 2, layer: undefined, mvp: 0, score: undefined, avatars: [] },
    { number: 3, layer: 0, score: 0, mvp: undefined, percentile: 0, avatars: [] },
    { number: 4, score: 14032, mvp: 62, percentile: 999, avatars: [
      { name: "甲", itemId: "1011", rarity: "S", score: 0, percentile: 0 },
      { name: "乙", itemId: "1021", rarity: "A", score: 112, percentile: 876 },
      { name: "丙", icon: medal, score: undefined, percentile: undefined },
    ] },
  ] });
  expect(result.seasons[3]?.avatars).toHaveLength(3);
});

test("爬塔区分赛季缺席、赛季字段缺失与响应不可信", () => {
  expect(normalizeZzzClimbingTower({ climbing_tower_s1: null }, identity)).toEqual({ ...identity, status: "empty", seasons: [] });
  const result = normalizeZzzClimbingTower({ climbing_tower_s1: {}, climbing_tower_s2: null }, identity);
  expect(result).toMatchObject({ status: "available", seasons: [{ number: 1, layer: undefined }] });
  for (const bad of [
    { uid: "87654321" }, { region: "prod_qd_cn" },
    { climbing_tower_s1: { role_id: 87654321 } }, { climbing_tower_s2: [] },
    { climbing_tower_s2: { climbing_tower_layer: -1 } },
    { climbing_tower_s3: { mvp_info: { rank_percent: 10001 } } },
    { climbing_tower_s4: { display_avatar_rank_list: "invalid" } },
  ]) expect(() => normalizeZzzClimbingTower(bad, identity)).toThrow(HoyoRequestError);
});

test("爬塔通过一次带设备与同档 Cookie 的签名 GET 获取所有赛季", async () => {
  const query = `lang=zh-cn&uid=${identity.uid}&region=${identity.region}`;
  let guarded = 0;
  const result = await readZzzClimbingTower(source, async (url, init) => {
    expect(url.href).toBe(`https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/climbing_tower_detail?${query}`);
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get("Cookie")).toBe("cookie_token=fixture-cookie");
    expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
    expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
    const [t, r, hash] = headers.get("DS")!.split(",");
    expect(hash).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${t}&r=${r}&b=&q=${query}`).digest("hex"));
    return Response.json({ retcode: 0, data: { climbing_tower_s2: { climbing_tower_layer: 33 } } });
  }, {}, async () => { guarded++; });
  expect(result.seasons[0]).toMatchObject({ number: 2, layer: 33 });
  expect(guarded).toBe(2);
  const overseas = { ...source, role: { ...source.role, uid: "1300000002", region: "prod_gf_jp", gameBiz: "nap_global" } };
  await expect(readZzzClimbingTower(overseas, async () => { throw new Error("不应请求国服接口"); }, {}))
    .rejects.toMatchObject({ code: "invalid-input" });
});

test("爬塔成功响应的显式 null 是空战绩，缺失 data 是异常响应", async () => {
  const call = (envelope: object) => readZzzClimbingTower(source, async () => Response.json(envelope), {});
  await expect(call({ retcode: 0, data: null })).resolves.toEqual({ ...identity, status: "empty", seasons: [] });
  await expect(call({ retcode: 0 })).rejects.toMatchObject({ code: "response" });
});
