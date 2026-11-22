import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { createHoyoClient, GameRecordRequestError, HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { readCnGameRecord } from "../packages/hoyo-client/game-record.ts";
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

test("绝区零面板只签旧基础查询，提交单个代理人编号并区分请验证", async () => {
  const query = "lang=zh-cn&role_id=12345678&server=prod_qd_cn&need_wiki=false";
  let requests = 0;
  await expect(readCnGameRecord(source, async (url, init) => {
    requests++;
    expect(url.href).toBe(`${endpoint}avatar/info?${query}&id_list%5B%5D=1091`);
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe("ltoken=fixture-cookie");
    const [time, nonce, hash] = headers.get("DS")!.split(",");
    const expected = createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${time}&r=${nonce}&b=&q=${query}`).digest("hex");
    expect(hash).toBe(expected);
    return new Response(JSON.stringify({ retcode: 0, data: { avatar_list: [] } }), { headers: { "x-rpc-aigis": '{"fixture":true}' } });
  }, { kind: "zzz-panel-detail", characterId: 1091 })).rejects.toMatchObject({ reason: "risk" });
  const unexpected = async () => { requests++; throw new Error("非法编号不应创建请求。"); };
  await expect(readCnGameRecord(source, unexpected, { kind: "zzz-panel-detail", characterId: 0 }))
    .rejects.toMatchObject({ code: "invalid-input" });
  expect(requests).toBe(1);
});

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

const international = {
  cookie: "ltuid_v2=42; ltoken_v2=fixture-token; ltmid_v2=fixture-mid",
  accountId: "42", realm: "SG" as const, language: "zh-cn", selectedUid: "1000000001", revision: "fixture-revision",
};
const internationalRole = { game_uid: "1000000001", region: "prod_gf_us", game_biz: "nap_global", nickname: "合成测试" };

test("绝区零国际服战绩只读取 HoYoLAB 本人角色，使用独立凭据和三个只读接口", async () => {
  const expected = [
    "https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken?game_biz=nap_global",
    ...["index", "avatar/basic", "buddy/info"].map(part =>
      `https://sg-act-public-api.hoyolab.com/event/game_record_zzz/api/zzz/${part}?lang=zh-cn&role_id=1000000001&server=prod_gf_us`),
  ];
  const data = [{ list: [internationalRole] }, { stats: index.stats, role: internationalRole },
    { game_biz: "nap_global", avatar_list: [avatar] }, { list: [buddy] }];
  let guards = 0;
  let requests = 0;
  const client = createHoyoClient(async (url, init) => {
    expect(url.href).toBe(expected[requests]!);
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
    expect(new Headers(init.headers).get("cookie")).toBe(international.cookie);
    return payload(data[requests++]);
  });
  const result = await client.fetchHoYoLabZzzGameRecord(international, { async verifyProfile() { guards++; } });
  expect(result).toMatchObject({
    revision: international.revision, uid: international.selectedUid, region: "prod_gf_us",
    role: { nickname: "合成测试", gameBiz: "nap_global" },
    avatars: [{ itemId: "1091", name: "雅" }], buddies: [{ itemId: "54001", name: "鲨牙布" }],
  });
  expect([requests, guards]).toEqual([4, 8]);
});

test("绝区零国际服战绩拒绝异人、错区、重复角色、错账号、风控与会话切换", async () => {
  for (const [list, code] of [
    [[{ ...internationalRole, game_uid: "1000000002" }], "invalid-input"],
    [[{ ...internationalRole, region: "prod_gf_eu" }], "invalid-input"],
    [[internationalRole, internationalRole], "invalid-input"],
    [[{ ...internationalRole, account_id: "43" }], "response"],
  ] as const) {
    let queries = 0;
    const client = createHoyoClient(async () => { queries++; return payload({ list }); });
    await expect(client.fetchHoYoLabZzzGameRecord(international, { async verifyProfile() {} })).rejects.toMatchObject({ code });
    expect(queries).toBe(1);
  }

  for (const [reply, expected] of [
    [() => payload({ stats: index.stats, role: { ...internationalRole, game_uid: "1000000002" } }), { code: "response" }],
    [() => Response.json({ retcode: 1034 }), { reason: "risk" }],
    [() => Response.json({ retcode: -100 }), { reason: "expired" }],
  ] as const) {
    let queries = 0;
    const client = createHoyoClient(async () => ++queries === 1 ? payload({ list: [internationalRole] }) : reply());
    await expect(client.fetchHoYoLabZzzGameRecord(international, { async verifyProfile() {} })).rejects.toMatchObject(expected);
    expect(queries).toBe(2);
  }

  let checks = 0;
  let queries = 0;
  const client = createHoyoClient(async () => { queries++; return payload({ list: [internationalRole] }); });
  await expect(client.fetchHoYoLabZzzGameRecord(international, {
    async verifyProfile() {
      if (++checks === 2) throw new HoyoRequestError("profile-changed", "合成档案切换");
    },
  })).rejects.toMatchObject({ code: "profile-changed" });
  expect(queries).toBe(1);
});
