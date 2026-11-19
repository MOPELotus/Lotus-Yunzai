import { expect, test } from "bun:test";
import type { ProfileRequestContext } from "../packages/account/index.ts";
import { normalizeGenshinWorldBoss, readGenshinWorldBoss } from "../packages/hoyo-client/genshin-world-boss.ts";
import { HoyoRequestError } from "../packages/hoyo-client/errors.ts";

const role = { uid: "123456789", region: "cn_gf01" };

test("原神世界 BOSS 只读取原国服战绩地址并检查档案版本", async () => {
  const source = {
    qq: "42", profileId: 2, game: "gs", revision: "fixture-revision",
    account: { cookie: "cookie_token=fixture-token" }, device: { id: "fixture-device", fp: "fixture-fp" },
    role: { ...role, gameBiz: "hk4e_cn" },
  } as ProfileRequestContext;
  let verified = 0;
  let requested = 0;
  const result = await readGenshinWorldBoss(source, async (endpoint, init) => {
    requested++;
    expect(endpoint.href).toBe("https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/index?role_id=123456789&server=cn_gf01");
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe("cookie_token=fixture-token");
    expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
    expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    return Response.json({ retcode: 0, data: { world_explorations: [{ name: "蒙德", boss_list: [{ name: "急冻树", kill_num: 0 }] }] } });
  }, {}, async () => { verified++; });
  expect([requested, verified]).toEqual([1, 2]);
  expect(result.groups).toEqual([{ name: "蒙德", bosses: [{ name: "急冻树", killCount: 0 }] }]);
  await expect(readGenshinWorldBoss({ ...source, role: { ...source.role, uid: "623456789", region: "os_usa" } },
    async () => { throw new Error("unexpected network"); })).rejects.toMatchObject({ code: "invalid-input" });
});

test("原神世界 BOSS 保留上游区域顺序、重复名称和有效零击杀", () => {
  const result = normalizeGenshinWorldBoss({
    role_id: 123456789, server: "cn_gf01", role: { game_uid: role.uid, region: role.region, game_biz: "hk4e_cn" },
    world_explorations: [
      { name: " 璃月 ", boss_list: [{ name: "无相之岩", kill_num: "0", icon: "https://fixture.invalid/untrusted" }] },
      { name: "层岩巨渊", exploration_percentage: 99 },
      { name: "蒙德", boss_list: [{ name: "急冻树", kill_num: 1000 }, { name: "急冻树", kill_num: 7 }] },
      { name: "稻妻", boss_list: [] },
    ],
    avatars: [{ fixture: "ignored" }],
  }, role);
  expect(result).toEqual({
    ...role, status: "available", groups: [
      { name: "璃月", bosses: [{ name: "无相之岩", killCount: 0 }] },
      { name: "蒙德", bosses: [{ name: "急冻树", killCount: 1000 }, { name: "急冻树", killCount: 7 }] },
      { name: "稻妻", bosses: [] },
    ],
  });
});

test("原神世界 BOSS 区分上游未提供统计与明确空列表", () => {
  for (const data of [
    {}, { role: null, world_explorations: [{ name: "枫丹", exploration_percentage: 1000 }] },
  ]) {
    expect(normalizeGenshinWorldBoss(data, role)).toEqual({ ...role, status: "unavailable", groups: [] });
  }
  expect(normalizeGenshinWorldBoss({ world_explorations: [] }, role))
    .toEqual({ ...role, status: "available", groups: [] });
  expect(normalizeGenshinWorldBoss({ world_explorations: [{ name: "蒙德", boss_list: [] }] }, role))
    .toEqual({ ...role, status: "available", groups: [{ name: "蒙德", bosses: [] }] });
});

test("即使击杀字段不可用也核对已声明角色、区服和游戏", () => {
  const cases = [
    [{ role_id: "223456789" }, "角色"],
    [{ uid: role.uid, game_uid: Number.MAX_SAFE_INTEGER + 1 }, "角色"],
    [{ server: "cn_qd01" }, "区服"],
    [{ role: { uid: "223456789", region: role.region } }, "角色"],
    [{ role: { game_uid: role.uid, server: "cn_qd01" } }, "区服"],
    [{ role: { game_biz: "hkrpg_cn" } }, "游戏"],
    [{ role: "fixture-secret" }, "角色"],
  ] as const;
  for (const [input, error] of cases) {
    expect(() => normalizeGenshinWorldBoss(input, role)).toThrow(error);
  }
});

test("非法响应列表、名称或计数不会被解释为可用的零", () => {
  const badCounts = [-1, 1.5, "1e2", "1.00", "9".repeat(17), null, false, undefined];
  const invalid = [
    null, [],
    { world_explorations: null },
    { world_explorations: Array.from({ length: 129 }, () => ({})) },
    { world_explorations: [false] },
    { world_explorations: [{ name: "区域", boss_list: null }] },
    { world_explorations: [{ name: "", boss_list: [] }] },
    { world_explorations: [{ name: "区域", boss_list: Array.from({ length: 2049 }, () => ({})) }] },
    ...[null, { name: "fixture-secret\n", kill_num: 1 }, ...badCounts.map((kill_num) => ({ name: "急冻树", kill_num }))]
      .map((entry) => ({ world_explorations: [{ name: "蒙德", boss_list: [entry] }] })),
  ];
  for (const value of invalid) {
    const error = (() => {
      try { normalizeGenshinWorldBoss(value, role); } catch (failure) { return failure; }
    })();
    expect(error).toBeInstanceOf(HoyoRequestError);
    expect(error).toMatchObject({ code: "response" });
    expect(String(error)).not.toContain("fixture-secret");
  }
});
