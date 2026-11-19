import { expect, test } from "bun:test";
import { verifyHoYoLabCookie } from "../packages/hoyo-client/hoyolab-cookie.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";

const v1 = "account_id=4201; cookie_token=fixture-token";
const v2 = "account_id_v2=4202; cookie_token_v2=v2_fixture-token; account_mid_v2=fixture-mid";
const endpoint = "/account/ma-passport/token/verifyCookieToken";

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
