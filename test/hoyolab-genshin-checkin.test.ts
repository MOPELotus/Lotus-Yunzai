import { expect, test } from "bun:test";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";
import { openHoYoLabGenshinCheckin } from "../packages/hoyo-client/hoyolab-genshin-checkin.ts";

const profile = {
  cookie: "account_id_v2=4201; cookie_token_v2=v2_fixture-token; account_mid_v2=fixture-mid",
  realm: "EU" as const, accountId: "4201", language: "EN_us",
};
const catalogEndpoint = "https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByCookieToken";
const infoEndpoint = "https://sg-act-public-api.hoyolab.com/event/sol/info";
const asia = { game_uid: "800000001", region: "os_asia", game_biz: "hk4e_global", is_chosen: true };
const europe = { game_uid: "700000001", region: "os_euro", game_biz: "hk4e_global" };
const verifyProfile = async () => {};
const confirmed = (data: object, headers?: HeadersInit) => Response.json({ retcode: 0, data }, { headers });

test("原神国际服以已核验 Cookie 读全区目录，活动只查档案级状态", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const steps: string[] = [];
  const transport: HoyoTransport = async (url, init) => {
    steps.push("GET");
    calls.push({ url: url.href, init });
    if (url.pathname.endsWith("getUserGameRolesByCookieToken")) {
      return confirmed({ list: [asia, europe], user_info: { aid: 4201, mid: "fixture-mid" } });
    }
    return calls.length === 2 ? confirmed({ is_sign: true, total_sign_day: 9, region: "os_euro" }) :
      confirmed({ is_sign: false, first_bind: true, role: { uid: 700000001, region: "os_euro" }, total_sign_day: "02" });
  };
  const reader = await openHoYoLabGenshinCheckin(profile, transport, {
    async verifyProfile() { steps.push("verify"); },
  });
  expect(reader.roles).toEqual([
    { uid: "800000001", region: "os_asia", gameBiz: "hk4e_global", chosen: true },
    { uid: "700000001", region: "os_euro", gameBiz: "hk4e_global" },
  ]);
  expect(await reader.readInfo()).toEqual({ signed: true, firstBind: false, totalSignDays: 9 });
  expect(await reader.readInfo()).toEqual({ signed: false, firstBind: true, totalSignDays: 2, role: reader.roles[1] });
  expect(calls.map(({ url }) => url)).toEqual([
    `${catalogEndpoint}?game_biz=hk4e_global`,
    `${infoEndpoint}?lang=en-us&act_id=e202102251931481`,
    `${infoEndpoint}?lang=en-us&act_id=e202102251931481`,
  ]);
  expect(steps).toEqual(["verify", "GET", "verify", "verify", "GET", "verify", "verify", "GET", "verify"]);
  for (const [index, { init }] of calls.entries()) {
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe(profile.cookie);
    expect(headers.get("origin")).toBe("https://act.hoyolab.com");
    expect(headers.get("ds")).toBeNull();
    expect(headers.get("x-rpc-signgame")).toBe(index === 0 ? null : "hk4e");
    expect(headers.get("x-rpc-language")).toBe(index === 0 ? "en" : null);
  }
});

test("伪造档案身份、海外角色目录无效或回包过大时拒绝", async () => {
  let requested = 0;
  for (const source of [
    { ...profile, accountId: "4202" }, { ...profile, realm: "Asia" as "EU" }, { ...profile, language: "en@evil" },
    { ...profile, cookie: profile.cookie + "; stoken=forbidden" },
    { ...profile, cookie: "account_id=4201; cookie_token=v2_wrong-key" },
  ]) {
    await expect(openHoYoLabGenshinCheckin(source, async () => {
      requested++;
      return confirmed({ list: [] });
    }, { verifyProfile })).rejects.toMatchObject({ code: "invalid-input" });
  }
  expect(requested).toBe(0);
  for (const data of [
    {}, { list: {} }, { list: [asia, asia] }, { list: [asia, { ...asia, region: "os_usa" }] },
    { list: [{ ...asia, game_uid: "0800000001" }] },
    { list: [{ ...asia, game_uid: Number.MAX_SAFE_INTEGER + 1 }] },
    { list: [{ ...asia, region: "cn_gf01" }] }, { list: [{ ...asia, game_biz: "hk4e_cn" }] },
    { list: [{ ...asia, account_id: "4001" }] },
    { list: [asia], ma_passport_region: "US" }, { list: [asia], padding: "x".repeat(132_000) },
  ]) {
    await expect(openHoYoLabGenshinCheckin(profile, async () => confirmed(data), { verifyProfile }))
      .rejects.toMatchObject({ code: "response" });
  }
  const v1 = { ...profile, cookie: "account_id=4201; cookie_token=fixture-v1", realm: "SG" as const, language: "ZH_TW" };
  const empty = await openHoYoLabGenshinCheckin(v1, async (url, request) => {
    expect(new Headers(request.headers).get("x-rpc-language")).toBe("zh-tw");
    expect(url.search).toBe("?game_biz=hk4e_global");
    return confirmed({ list: [] });
  }, { verifyProfile });
  expect(empty.roles).toEqual([]);
});

test("返回的角色与账号信息若冲突即拒绝，风控与过期单独报告", async () => {
  let state = confirmed({ is_sign: true });
  let queried = 0;
  const reader = await openHoYoLabGenshinCheckin(profile, async (url) => {
    if (url.hostname === "api-account-os.hoyolab.com") return confirmed({ list: [asia, europe] });
    queried++;
    return state;
  }, { verifyProfile });
  for (const data of [
    { game_uid: "900000001" },
    { role_id: "700000001", region: "os_asia" },
    { region: "os_cht" },
    { uid: asia.game_uid, role: { game_uid: europe.game_uid } },
    { game_biz: "hk4e_cn" },
    { user_info: { aid: "4202" } },
    { user_info: { mid: "different-mid" } },
    { is_sign: "true" },
    { first_bind: "true" },
    { total_sign_day: 32 },
  ]) {
    state = confirmed({ is_sign: true, ...data });
    await expect(reader.readInfo()).rejects.toMatchObject({ code: "response" });
  }
  for (const [value, reason] of [
    [Response.json({ retcode: -100, data: null, message: "raw secret" }), "expired"],
    [Response.json({ retcode: 1034, message: "raw secret" }), "risk"],
    [confirmed({ gt_result: { is_risk: true, challenge: "raw secret" }, is_sign: false }), "risk"],
    [confirmed({ is_sign: true }, { "x-rpc-aigis": "raw secret" }), "risk"],
    [new Response(null, { status: 429 }), "rate-limited"],
  ] as const) {
    state = value;
    const before = queried;
    const response = reader.readInfo();
    await expect(response).rejects.toMatchObject({ reason });
    await expect(response).rejects.not.toThrow(/raw secret|fixture-token/u);
    expect(queried).toBe(before + 1);
  }
  state = Response.redirect("https://example.invalid/");
  await expect(reader.readInfo()).rejects.toMatchObject({ code: "http" });
});

test("角色目录和状态在出站前与响应后都复核档案，断开后停止读取", async () => {
  const controller = new AbortController();
  let generation = 1;
  let requests = 0;
  const reader = await openHoYoLabGenshinCheckin(profile, async (url) => {
    requests++;
    if (url.hostname === "api-account-os.hoyolab.com") return confirmed({ list: [asia] });
    generation++;
    return confirmed({ is_sign: true });
  }, {
    signal: controller.signal,
    async verifyProfile() { if (generation !== 1) throw new Error("档案已变更"); },
  });
  await expect(reader.readInfo()).rejects.toThrow("档案已变更");
  await expect(reader.readInfo()).rejects.toThrow("档案已变更");
  expect(requests).toBe(2);
  controller.abort();
  await expect(reader.readInfo()).rejects.toMatchObject({ code: "transport" });
  expect(requests).toBe(2);
});
