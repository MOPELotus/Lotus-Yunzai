import { expect, test } from "bun:test";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { createHoyoClient, GameRecordRequestError, HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { readZzzGameRecord } from "../packages/hoyo-client/zzz-game-record.ts";

const source = {
  qq: "42", profileId: 2, game: "zzz", revision: "fixture-revision",
  account: { cookie: "ltoken=fixture-cookie" }, device: { id: "fixture-device", fp: "fixture-fp" },
  role: { uid: "12345678", region: "prod_qd_cn", gameBiz: "nap_cn" },
} as ProfileRequestContext;
const endpoint = "https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/";
const index = {
  uid: 12345678, stats: { active_days: "0", avatar_num: 1, buddy_num: 1, cur_period_zone_layer_count: "3/7" },
};
const avatar = { id: 1091, name_mi18n: "雅", element_type: 202, sub_element_type: 1, rarity: "S", level: 60, rank: 0 };
const buddy = { id: 54001, name: "鲨牙布", rarity: "S", level: 50, star: 2, bangboo_square_url: "https://act-webstatic.mihoyo.com/buddy.png" };
const payload = (data: unknown) => Response.json({ retcode: 0, data });

test("绝区零个人战绩按同档案顺序读取概览、代理人与邦布", async () => {
  const requests: string[] = [];
  const replies = [index, { avatar_list: [avatar] }, { list: [buddy] }];
  let checks = 0;
  const result = await readZzzGameRecord(source, async (url, init) => {
    requests.push(url.href);
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe("ltoken=fixture-cookie");
    expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
    expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
    return payload(replies[requests.length - 1]);
  }, {}, async () => { checks++; });
  expect(requests).toEqual(["index", "avatar/basic", "buddy/info"].map((path) =>
    endpoint + path + "?lang=zh-cn&role_id=12345678&server=prod_qd_cn"));
  expect(checks).toBe(6);
  expect(result).toMatchObject({
    uid: source.role.uid, region: source.role.region,
    stats: { active_days: 0, avatar_num: 1, buddy_num: 1, cur_period_zone_layer_count: "3/7" },
    avatars: [{ itemId: "1091", name: "雅", rarity: "S", level: 60, rank: 0, element: "Frost" }],
    buddies: [{ itemId: "54001", name: "鲨牙布", rarity: "S", level: 50, rank: 2, icon: buddy.bangboo_square_url }],
  });
});

test("旧 Cookie 验证拦截与错区不继续索取第三个战绩接口", async () => {
  for (const [erroneous, expectation] of [
    [() => Response.json({ retcode: 1034, message: "合成验证提示" }), GameRecordRequestError],
    [() => payload({ server: "prod_gf_cn", avatar_list: [] }), HoyoRequestError],
    [() => payload({ avatar_list: [avatar, avatar] }), HoyoRequestError],
  ] as const) {
    let requested = 0;
    await expect(readZzzGameRecord(source, async () => ++requested === 1 ? payload(index) : erroneous()))
      .rejects.toBeInstanceOf(expectation);
    expect(requested).toBe(2);
  }
});

test("战绩版本变化时丢弃已读响应并阻止后续请求", async () => {
  let requests = 0;
  let guardCalls = 0;
  await expect(readZzzGameRecord(source, async () => {
    requests++;
    return payload(index);
  }, {}, async () => {
    if (++guardCalls === 2) throw new HoyoRequestError("profile-changed", "合成档案切换");
  })).rejects.toMatchObject({ code: "profile-changed" });
  expect(requests).toBe(1);
});

test("绝区零战绩接受空列表，国际服角色不会把国服 Cookie 发送到战绩端点", async () => {
  const replies = [index, { avatar_list: [] }, { list: [] }];
  const read = createHoyoClient(async () => payload(replies.shift()));
  const result = await read.fetchZzzGameRecord(source);
  expect([result.avatars, result.buddies]).toEqual([[], []]);
  expect(result.revision).toBe(source.revision);
  const overseas = { ...source, role: { ...source.role, uid: "1000000001", region: "prod_gf_us", gameBiz: "nap_global" } };
  await expect(read.fetchZzzGameRecord(overseas)).rejects.toMatchObject({ code: "invalid-input" });
});
