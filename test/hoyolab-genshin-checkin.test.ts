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

test("原神国际服只提交一次账号默认角色签到，官方受理须独立回读", async () => {
  const deviceId = "12345678-1234-4abc-8abc-1234567890ab";
  const sent: string[] = [];
  let count = 0;
  const reader = await openHoYoLabGenshinCheckin(profile, async (url, init) => {
    sent.push(`${init.method} ${url.href}`);
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe(profile.cookie);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    if (url.hostname === "api-account-os.hoyolab.com") return confirmed({ list: [asia, europe] });
    if (init.method === "POST") {
      expect(init.body).toBe('{"act_id":"e202102251931481"}');
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-rpc-device_id")).toBe(deviceId);
      expect(headers.get("x-rpc-platform")).toBe("4");
      expect(headers.get("x-rpc-signgame")).toBe("hk4e");
      expect(headers.get("x-rpc-device_fp")).toBeNull();
      expect(headers.get("x-rpc-challenge")).toBeNull();
      return confirmed({ first_bind: false });
    }
    return confirmed({ is_sign: ++count === 2 });
  }, { deviceId, verifyProfile });
  const options = { blockedUids: ["600000001"] };
  await expect(reader.submit(options)).rejects.toMatchObject({ code: "invalid-input" });
  expect((await reader.readInfo()).signed).toBe(false);
  // An explicitly chosen role cannot make a potentially different default role safe.
  await expect(reader.submit({ blockedUids: [europe.game_uid] })).rejects.toMatchObject({ code: "invalid-input" });
  const submitted = reader.submit(options);
  await expect(reader.submit(options)).rejects.toMatchObject({ code: "invalid-input" });
  expect(await submitted).toBe("accepted");
  expect((await reader.readInfo()).signed).toBe(true);
  await expect(reader.submit(options)).rejects.toMatchObject({ code: "invalid-input" });
  expect(sent).toEqual([
    `GET ${catalogEndpoint}?game_biz=hk4e_global`,
    `GET ${infoEndpoint}?lang=en-us&act_id=e202102251931481`,
    "POST https://sg-act-public-api.hoyolab.com/event/sol/sign?lang=en-us",
    `GET ${infoEndpoint}?lang=en-us&act_id=e202102251931481`,
  ]);
});

test("目录为空、已签、首绑和失败状态都不能开启国际服默认角色提交", async () => {
  let posts = 0;
  for (const [list, state] of [
    [[], confirmed({ is_sign: false })],
    [[asia], confirmed({ is_sign: true })],
    [[asia], confirmed({ is_sign: false, first_bind: true })],
    [[asia], confirmed({ is_sign: false, uid: europe.game_uid, region: "os_euro" })],
  ] as const) {
    const reader = await openHoYoLabGenshinCheckin(profile, async (url, { method }) => {
      if (method === "POST") posts++;
      return url.hostname === "api-account-os.hoyolab.com" ? confirmed({ list }) : state;
    }, { verifyProfile });
    await reader.readInfo().catch(() => undefined);
    await expect(reader.submit({ blockedUids: [] })).rejects.toMatchObject({ code: "invalid-input" });
  }
  expect(posts).toBe(0);
  await expect(openHoYoLabGenshinCheckin(profile, async () => {
    throw new Error("unexpected network");
  }, { verifyProfile, deviceId: "not a UUID" })).rejects.toMatchObject({ code: "invalid-input" });
});

test("国际服提交风控、非零回执与未知状态均不重发", async () => {
  for (const [outcome, detail] of [
    [confirmed({ gt_result: { is_risk: true, challenge: "isolated" } }), { reason: "risk" }],
    [confirmed({ gt_result: { is_risk: "unknown" } }), { code: "response" }],
    [Response.json({ retcode: -5003, data: {} }), { code: "api", retcode: -5003 }],
    [new Response(null, { status: 503 }), { code: "http", status: 503 }],
  ] as const) {
    let posts = 0;
    const reader = await openHoYoLabGenshinCheckin(profile, async (url, init) => {
      if (url.hostname === "api-account-os.hoyolab.com") return confirmed({ list: [asia] });
      if (init.method === "GET") return confirmed({ is_sign: false });
      posts++;
      expect(new Headers(init.headers).get("x-rpc-device_id"))
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      return outcome;
    }, { verifyProfile });
    await reader.readInfo();
    const planned = { blockedUids: [] };
    const attempt = reader.submit(planned);
    await expect(attempt).rejects.toMatchObject(detail);
    await expect(attempt).rejects.not.toThrow(/isolated|fixture-token/u);
    await reader.readInfo();
    await expect(reader.submit(planned)).rejects.toMatchObject({ code: "invalid-input" });
    expect(posts).toBe(1);
  }
});

test('account-wide info accepts the official empty region sentinel without accepting conflicting identities',async()=>{
 let state:Record<string,unknown>={is_sign:false,region:'',total_sign_day:0};
 const reader=await openHoYoLabGenshinCheckin(profile,async url=>url.pathname.endsWith('getUserGameRolesByCookieToken')?confirmed({list:[asia,europe]}):confirmed(state),{verifyProfile});
 expect(await reader.readInfo()).toMatchObject({signed:false,totalSignDays:0});
 for(const invalid of[{game_biz:'hk4e_cn'},{uid:'800000001'},{role:{region:''}},{region:'os_cht'}]){state={is_sign:false,region:'',...invalid};await expect(reader.readInfo()).rejects.toMatchObject({code:'response'});}
});
