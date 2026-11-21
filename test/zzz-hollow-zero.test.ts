import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import { normalizeZzzHollowZero, readZzzHollowZero } from "../packages/hoyo-client/zzz-hollow-zero.ts";

const identity = { uid: "12345678", region: "prod_gf_cn" };
const source = {
  qq: "42", profileId: 1, game: "zzz", revision: "fixture-revision",
  account: { cookie: "cookie_token=fixture-cookie" }, device: { id: "fixture-device", fp: "fixture-fp" },
  role: { ...identity, gameBiz: "nap_cn" },
} as ProfileRequestContext;
const summary = {
  abyss_level: { cur_level: 0, max_level: 60 }, abyss_collect: [null, { cur_collect: 14 }],
  abyss_throne: { max_damage: "2512345678" },
};
const detail = { abyss_throne_max: {
  time: 0, avatar_list: [{ id: 1011, level: 60, rank: 0, damage_rate: 0 }, null, { id: 1021, damage_rate: "31.1%" }],
  buddy_list: [{ id: 54001, level: 60 }],
} };

test("枯萎苗圃保留分栏顺序、摘要伤害、阵容空位和实际零值", () => {
  const result = normalizeZzzHollowZero(summary, detail, identity, "withered");
  expect(result).toMatchObject({ hollowMode: "withered", status: "available", license: { current: 0, maximum: 60 },
    collection: [{}, { current: 14, maximum: undefined }], maxDamage: 2512345678,
    throne: { seconds: 0, damage: undefined, avatars: [
      { itemId: "1011", level: 60, rank: 0, damageRate: "0" }, undefined,
      { itemId: "1021", level: undefined, damageRate: "31.1" },
    ], buddy: { itemId: "54001", level: 60 } } });
});

test("迷失之地保留矩阵、特遣、原处理器的特别行动时间与缺席字段", () => {
  const result = normalizeZzzHollowZero({ abyss_duty: { cur_duty: 0 }, abyss_task: { max_task: 50 },
    abyss_collect: Array.from({ length: 7 }, (_, index) => ({ cur_collect: index })),
    abyss_max: { max_name: "矩阵合成", max_count: 0, heat_count: 0, best_time: 0 },
    abyss_task_force_investigation_max: { best_time: "3723" },
    special_mission: { best_time: 0 } }, undefined, identity, "lost");
  expect(result).toMatchObject({ hollowMode: "lost", collection: Array.from({ length: 7 }, (_, index) => ({ current: index })),
    duty: { current: 0, maximum: undefined }, task: { current: undefined, maximum: 50 },
    matrix: { name: "矩阵合成", count: 0, heat: 0, seconds: 0 },
    taskForce: { seconds: 3723, count: undefined }, specialMission: { seconds: 0 }, status: "available" });
  expect(normalizeZzzHollowZero({}, undefined, identity, "lost").status).toBe("empty");
});

test("两条零号空洞路由使用固定查询次序、DS、Cookie、设备与档案校验", async () => {
  const calls: string[] = [];
  let guarded = 0;
  async function transport(url: URL, init: RequestInit) {
    calls.push(url.pathname.split("/").at(-1)! + url.search);
    const headers = new Headers(init.headers);
    expect(url.hostname).toBe("api-takumi-record.mihoyo.com");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(headers.get("Cookie")).toBe("cookie_token=fixture-cookie");
    expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
    expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
    const [t, r, hash] = headers.get("DS")!.split(",");
    expect(hash).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${t}&r=${r}&b=&q=${url.search.slice(1)}`).digest("hex"));
    return Response.json({ retcode: 0, data: url.pathname.endsWith("abyss_abstract") ? summary : null });
  }
  const verify = async () => { guarded++; };
  expect(await readZzzHollowZero(source, transport, { hollowMode: "withered" }, verify))
    .toMatchObject({ status: "available", maxDamage: 2512345678, throne: undefined });
  expect(await readZzzHollowZero(source, transport, { hollowMode: "lost" }, verify)).toMatchObject({ status: "empty" });
  expect(calls).toEqual([
    "abyss_abstract?lang=zh-cn&role_id=12345678&server=prod_gf_cn",
    "abyss_detail?lang=zh-cn&role_id=12345678&server=prod_gf_cn&type=3",
    "abysss2_abstract?lang=zh-cn&uid=12345678&region=prod_gf_cn",
  ]);
  expect(guarded).toBe(6);
});

test("零伤害不查询详情，并拒绝档案不符的摘要及补充数据", async () => {
  let calls = 0;
  async function transport() {
    calls++;
    return Response.json({ retcode: 0, data: { abyss_throne: { max_damage: "0" } } });
  }
  expect(await readZzzHollowZero(source, transport, { hollowMode: "withered" }))
    .toMatchObject({ maxDamage: 0, status: "available" });
  expect(calls).toBe(1);
  expect(() => normalizeZzzHollowZero({ role_id: "22345678" }, undefined, identity, "withered")).toThrow(HoyoRequestError);
  expect(() => normalizeZzzHollowZero(summary, { region: "prod_qd_cn" }, identity, "withered")).toThrow(HoyoRequestError);
});
