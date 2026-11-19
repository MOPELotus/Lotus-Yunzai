import { expect, test } from "bun:test";
import { verifyHoYoLabCookie } from "../packages/hoyo-client/hoyolab-cookie.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";

const v1 = "account_id=4201; cookie_token=fixture-token";
const v2 = "account_id_v2=4202; cookie_token_v2=v2_fixture-token; account_mid_v2=fixture-mid";
const endpoint = "/account/ma-passport/token/verifyCookieToken";
const activityEndpoint = "/account/ma-passport/token/verifyLToken";
const activityV1 = "ltuid=4201; ltoken=fixture-activity";
const activityV2 = "ltuid_v2=4202; ltoken_v2=v2_fixture-activity; ltmid_v2=fixture-mid";

function confirmed(user_info: Record<string, unknown>, data: Record<string, unknown> = {}, headers?: HeadersInit) {
  return Response.json({ retcode: 0, data: { ...data, user_info } }, { headers });
}

test("国际服通行证按单一官方域验证请求，最小化 v1/v2 Cookie 并返回精确 AID", async () => {
  const events: string[] = [];
  const check = (realm: string, cookie: string, result: Response): HoyoTransport => async (url, init) => {
    events.push("request");
    expect(url.href).toBe(`https://passport-api-${realm.toLowerCase()}.hoyolab.com${endpoint}`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.signal?.aborted).toBe(false);
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe(cookie);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("origin")).toBe("https://act.hoyolab.com");
    expect(headers.get("x-rpc-source")).toBe("v2.webLogin");
    expect(headers.get("x-rpc-app_id")).toBe("c9oqaq3s3gu8");
    expect(headers.get("x-rpc-domain_redirect")).toBe(realm === "SG" ? null : "true");
    return result;
  };
  expect(await verifyHoYoLabCookie(`XSRF-TOKEN=unrelated; ${v1}; ltuid=4201; stoken=opaque`,
    check("SG", v1, confirmed({ aid: 4201, mid: "not-asserted-by-v1" })),
    { async verifyProfile() { events.push("verify"); } },
  )).toEqual({ cookie: v1, accountId: "4201", realm: "SG" });
  expect(events).toEqual(["verify", "request", "verify"]);

  for (const realm of ["US", "EU"] as const) {
    expect(await verifyHoYoLabCookie(`${v2}; ma_passport_region=${realm.toLowerCase()}; ltmid_v2=fixture-mid; ltuid_v2=4202; theme=dark`,
      check(realm, v2, confirmed({ aid: "4202", mid: "fixture-mid" }, { ma_passport_region: realm })),
    )).toEqual({ cookie: v2, accountId: "4202", realm });
  }
  const exactId = "9007199254740993";
  const longCookie = `account_id=${exactId}; cookie_token=fixture-token`;
  expect(await verifyHoYoLabCookie(longCookie, check("SG", longCookie, confirmed({ aid: exactId }))))
    .toEqual({ cookie: longCookie, accountId: exactId, realm: "SG" });
});

test("国际服 Cookie 格式错误、归属冲突或未知地区在任何请求前拒绝", async () => {
  let calls = 0;
  for (const input of [
    "", "ltuid=4201; ltoken=fixture", "account_id=04201; cookie_token=fixture-token",
    "account_id=4201; cookie_token=v2_fixture-token", "account_id_v2=4202; cookie_token_v2=v2_fixture-token",
    "account_id=4202; cookie_token_v2=v2_fixture-token; account_mid_v2=fixture-mid",
    `${v1}; cookie_token_v2=v2_fixture-token`, `${v2}; account_mid_v2=fixture-mid`,
    `${v2}; ltmid_v2=conflicting-mid`, `${v1}; ltuid_v2=4299`, `${v1}; ma_passport_region=ASIA`,
    `${v1}\r\nInjected: true`, `${v1}; missing-equals`, `${v1}; foo=${"x".repeat(16_384)}`,
  ]) {
    await expect(verifyHoYoLabCookie(input, async () => {
      calls++;
      return confirmed({ aid: "4201" });
    })).rejects.toMatchObject({ code: "invalid-input" });
  }
  expect(calls).toBe(0);
});

test("账号证明只接受精确匹配的成功回包，近期响应未知或风险时不换域、不重试", async () => {
  const noMatch = [
    confirmed({ aid: "4201", mid: "fixture-mid" }),
    confirmed({ aid: "04202" }),
    confirmed({ aid: 9_007_199_254_740_992 }),
    confirmed({ aid: "4202", account_id: 4203 }),
    confirmed({ aid: "4202", mid: "another-mid" }),
    confirmed({ aid: "4202" }, { account_mid_v2: "another-mid" }),
    confirmed({ aid: "4202", ma_passport_region: "US" }),
    confirmed({ aid: "4202" }, {}, { "x-rpc-ma_passport_region": "US" }),
    Response.json({ retcode: 0, data: { aid: "4202" } }),
    Response.json({ retcode: "0", data: { user_info: { aid: "4202" } } }),
    new Response("not json"),
    new Response(JSON.stringify({ retcode: 0, data: { user_info: { aid: "4202", surplus: "x".repeat(33_000) } } })),
  ];
  for (const response of noMatch) {
    let calls = 0;
    await expect(verifyHoYoLabCookie(v2, async () => { calls++; return response; }))
      .rejects.toMatchObject({ code: "response" });
    expect(calls).toBe(1);
  }
  for (const [response, code] of [
    [new Response(null, { status: 429 }), "http"],
    [Response.redirect("https://example.invalid/"), "http"],
    [confirmed({ aid: "4202" }, {}, { "x-rpc-aigis": "service-generated-challenge" }), "api"],
    [Response.json({ retcode: -100, message: "no raw provider failure" }), "api"],
  ] as const) {
    let calls = 0;
    const outcome = verifyHoYoLabCookie(v2, async () => { calls++; return response; });
    await expect(outcome).rejects.toMatchObject({ code });
    await expect(outcome).rejects.not.toThrow(/fixture-token|service-generated-challenge|no raw provider failure/u);
    expect(calls).toBe(1);
  }
});

test("档案换绑或读取中取消会作废国际服账号证明", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(verifyHoYoLabCookie(v1, async () => { throw new Error("unexpected request"); }, { signal: controller.signal }))
    .rejects.toMatchObject({ code: "transport" });
  const changed = new Error("档案变更");
  let checks = 0;
  const outcome = verifyHoYoLabCookie(v1, async () => confirmed({ aid: 4201 }), { async verifyProfile() {
    if (++checks === 2) throw changed;
  } });
  await expect(outcome).rejects.toBe(changed);

  const inFlight = new AbortController();
  const reading = Promise.withResolvers<void>();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() { reading.resolve(); },
    cancel() { cancelled = true; },
  });
  const pending = verifyHoYoLabCookie(v1, async () => new Response(stream), { signal: inFlight.signal });
  await reading.promise;
  inFlight.abort();
  await expect(pending).rejects.toMatchObject({ code: "transport" });
  expect(cancelled).toBe(true);
});

test("完整的国际服活动凭据在同一 realm 独立核对账号，两个规范 Cookie 保持分离", async () => {
  for (const [cookie, activityCookie, aid, realm] of [
    [v1, activityV1, "4201", "SG"], [v2, activityV2, "4202", "EU"],
  ] as const) {
    const observed: Array<[string, string | null]> = [];
    const steps: string[] = [];
    const scope = {
      async verifyProfile() { steps.push("verify"); },
    };
    const proof = await verifyHoYoLabCookie(`${cookie}; ${activityCookie}; ma_passport_region=${realm}; theme=dark`,
      async (url, init) => {
        steps.push("request");
        observed.push([url.href, new Headers(init.headers).get("Cookie")]);
        expect(init).toMatchObject({ method: "POST", body: "{}", redirect: "error", credentials: "omit",
          referrerPolicy: "no-referrer" });
        expect(new Headers(init.headers).get("x-rpc-domain_redirect")).toBe(realm === "SG" ? null : "true");
        return confirmed({ aid, ...(realm === "EU" && { mid: "fixture-mid" }) }, { ma_passport_region: realm });
      }, scope);
    const base = `https://passport-api-${realm.toLowerCase()}.hoyolab.com`;
    expect(observed).toEqual([[base + endpoint, cookie], [base + activityEndpoint, activityCookie]]);
    expect(steps).toEqual(["verify", "request", "verify", "verify", "request", "verify"]);
    expect(proof).toEqual({ cookie, activityCookie, accountId: aid, realm });
  }
});

test("活动 Cookie 不完整、混版本或账号冲突时发起零请求", async () => {
  for (const input of [
    `${v1}; ltoken=fixture-activity`,
    `${v1}; ltuid=4203; ltoken=fixture-activity`,
    `${v1}; ltuid=4201; ltoken=v2_fixture-activity`,
    `${v2}; ltuid_v2=4202; ltoken_v2=v2_fixture-activity`,
    `${v2}; ltoken=other; ${activityV2}`,
    `${v2}; ${activityV2.replace("ltmid_v2=fixture-mid", "ltmid_v2=different")}`,
  ]) {
    let attempts = 0;
    await expect(verifyHoYoLabCookie(input, async () => {
      attempts++;
      return confirmed({ aid: 4201 });
    })).rejects.toMatchObject({ code: "invalid-input" });
    expect(attempts).toBe(0);
  }
});

test("首次证明失败跳过活动验证，第二次身份失败或档案换绑不会返回部分证明", async () => {
  const input = `${v2}; ${activityV2}; ma_passport_region=US`;
  let attempts = 0;
  await expect(verifyHoYoLabCookie(input, async () => {
    attempts++;
    return confirmed({ aid: "4201" });
  })).rejects.toMatchObject({ code: "response" });
  expect(attempts).toBe(1);

  for (const [response, failure] of [
    [confirmed({ aid: "4201" }), { code: "response" }],
    [confirmed({ aid: "4202", mid: "wrong-mid" }), { code: "response" }],
    [confirmed({ aid: "4202", ma_passport_region: "SG" }), { code: "response" }],
    [Response.redirect("https://example.invalid"), { code: "http" }],
    [Response.json({ retcode: -100, message: "fixture-activity-token" }), { code: "api", retcode: -100 }],
  ] as const) {
    attempts = 0;
    const result = verifyHoYoLabCookie(input, async () => ++attempts === 1 ? confirmed({ aid: "4202" }) : response);
    await expect(result).rejects.toMatchObject(failure);
    await expect(result).rejects.not.toThrow(/fixture-activity-token/u);
    expect(attempts).toBe(2);
  }

  attempts = 0;
  let checks = 0;
  const changed = new Error("档案已变更");
  await expect(verifyHoYoLabCookie(input, async () => {
    attempts++;
    return confirmed({ aid: "4202" });
  }, { async verifyProfile() {
    if (++checks === 3) throw changed;
  } })).rejects.toBe(changed);
  expect(attempts).toBe(1);
});
