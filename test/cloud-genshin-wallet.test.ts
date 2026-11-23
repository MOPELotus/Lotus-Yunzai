import { expect, test } from "bun:test";
import { normalizeCloudGenshinComboToken, readCloudGenshinWallet } from "../packages/hoyo-client/cloud-genshin-wallet.ts";

const token = "ai=mhy&ct=fixture%2Bopaque&sig=plus+equals=";
const browserToken = "ai=4;ci=1;oi=fixture-open;ct=fixture%2Bopaque==;si=fixture-sig;bi=hk4e_cn";
const browserDeviceId = "1675a516-e0be-4c85-8095-36e4bcd382f6";
const walletUrl = "https://api-cloudgame.mihoyo.com/hk4e_cg_cn/wallet/wallet/get";

test("只向国内官方云钱包 GET 发送不透明凭据与独立浏览器设备标识", async () => {
  const steps: string[] = [];
  const result = await readCloudGenshinWallet(` ${token} `, async (endpoint, request) => {
    steps.push("read");
    expect(endpoint.href).toBe(walletUrl);
    expect(request.method).toBe("GET");
    expect(request.body).toBeUndefined();
    expect(request.credentials).toBe("omit");
    expect(request.redirect).toBe("error");
    expect(request.referrerPolicy).toBe("no-referrer");
    const headers = new Headers(request.headers);
    expect(headers.get("x-rpc-combo_token")).toBe(token);
    expect(headers.get("x-rpc-device_id")).toBe(browserDeviceId);
    expect(headers.get("x-rpc-client_type")).toBe("19");
    expect(headers.get("x-rpc-cg_game_biz")).toBe("hk4e_cn");
    expect(headers.get("x-rpc-op_biz")).toBe("clgm_cn");
    expect(headers.get("Origin")).toBe("https://ys.mihoyo.com");
    for (const key of ["Cookie", "Authorization", "DS", "x-rpc-device_fp", "x-rpc-app_id", "x-rpc-challenge"]) {
      expect(headers.has(key)).toBe(false);
    }
    return Response.json({ retcode: 0, data: {
      free_time: { free_time: "0", send_freetime: 15 },
      play_card: { remaining_sec: 3600 }, uid: "fixture-game-uid", aid: "fixture-mihoyo-aid", debug: token,
    } });
  }, { browserDeviceId, verifyProfile: async () => { steps.push("guard"); } });
  expect(result).toEqual({ freeTimeMinutes: 0, grantedMinutes: 15 });
  expect(steps).toEqual(["guard", "read", "guard"]);
});

test("可分配独立浏览器 UUID，云凭据和设备字段不接受 Cookie 或请求头注入", async () => {
  expect(normalizeCloudGenshinComboToken(token)).toBe(token);
  const devices: string[] = [];
  for (let index = 0; index < 2; index++) {
    const state = await readCloudGenshinWallet("fixture.opaque-token", async (_endpoint, request) => {
      const headers = new Headers(request.headers);
      devices.push(headers.get("x-rpc-device_id")!);
      return Response.json({ retcode: 0, data: { free_time: { free_time: 610 } } });
    });
    expect(state).toEqual({ freeTimeMinutes: 610 });
  }
  expect(new Set(devices).size).toBe(2);
  for (const device of devices) {
    expect(device).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
  }
  let calls = 0;
  const transport = async () => { calls++; return Response.json({ retcode: 0 }); };
  for (const bad of [" ", "abc\r\nCookie: other", "abc\tdef", "stoken=abc", "ltoken_v2=abc", "cookie_token=abc;account_id=778", "应为令牌", "t".repeat(8193)]) {
    await expect(readCloudGenshinWallet(bad, transport)).rejects.toMatchObject({ code: "invalid-input" });
  }
  await expect(readCloudGenshinWallet(token, transport, { browserDeviceId: "fixture-bbs-device" })).rejects.toMatchObject({ code: "invalid-input" });
  expect(calls).toBe(0);
});

test("官网分号凭据逐字保留，从同一云会话读取 app_id，拒绝重复字段与跨游戏", async () => {
  let requests = 0;
  for (const input of [browserToken, browserToken.replace("ai=4", "ai=47")]) {
    expect(normalizeCloudGenshinComboToken(input)).toBe(input);
    await expect(readCloudGenshinWallet(input, async (_url, request) => {
      requests++;
      const headers = new Headers(request.headers);
      expect(headers.get("x-rpc-combo_token")).toBe(input);
      expect(headers.get("x-rpc-app_id")).toBe(input.split(";")[0]!.slice(3));
      return Response.json({ retcode: 0, data: { free_time: { free_time: "12" } } });
    })).resolves.toEqual({ freeTimeMinutes: 12 });
  }
  for (const invalid of [
    browserToken + ";ai=4", browserToken + ";", browserToken.replace(";ci=1", ""),
    browserToken.replace("bi=hk4e_cn", "bi=nap_cn"), browserToken.replace("bi=hk4e_cn", "bi=hk4e_global"),
    browserToken.replace("ai=4", "ai=4,5"), browserToken.replace("ct=fixture%2Bopaque==", "cookie_token_v2=secret"),
    browserToken.replace(";ci=1", "; ci=1"), browserToken.replace("si=fixture-sig", "si=\nfixture-sig"),
  ]) {
    await expect(readCloudGenshinWallet(invalid, async () => { requests++; return Response.json({}); }))
      .rejects.toMatchObject({ code: "invalid-input" });
  }
  expect(requests).toBe(2);
});

test("失效、限频、验证、异常响应和未知余额都有固定原因且不会再次请求", async () => {
  const secret = "fixture-provider-secret";
  for (const [response, error] of [
    [() => Response.json({ retcode: -100, message: secret, data: null }), { reason: "expired", status: 200 }],
    [() => Response.json({ retcode: -100, message: secret }, { status: 401 }), { reason: "expired", status: 401 }],
    [() => new Response(secret, { status: 401 }), { code: "http", status: 401 }],
    [() => new Response(secret, { status: 429 }), { reason: "rate-limited" }],
    [() => new Response(secret, { headers: { "x-rpc-aigis": secret } }), { reason: "risk" }],
    [() => Response.redirect("https://redirect.invalid/cloud", 307), { code: "http", status: 307 }],
    [() => Response.json({ retcode: 19, message: secret }), { code: "api", retcode: 19 }],
    [() => Response.json({ retcode: "0", data: { free_time: { free_time: 3 } } }), { code: "response" }],
    [() => Response.json({ retcode: 0, data: { free_time: { send_freetime: 15 } } }), { code: "response" }],
    [() => new Response("x".repeat(131_073)), { code: "response" }],
  ] as const) {
    let calls = 0;
    const pending = readCloudGenshinWallet(token, async () => { calls++; return response(); });
    await expect(pending).rejects.toMatchObject(error);
    await expect(pending).rejects.not.toThrow(secret);
    expect(calls).toBe(1);
  }
  for (const free_time of [null, false, -1, 1.5, " ", "1e2", "9007199254740992"]) {
    await expect(readCloudGenshinWallet(token, async () => Response.json({ retcode: 0, data: { free_time: { free_time } } })))
      .rejects.toMatchObject({ code: "response" });
  }
});

test("取消和换绑在请求前、回包后和传输失败时均能中止", async () => {
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  const clean = async () => {
    calls++;
    return Response.json({ retcode: 0, data: { free_time: { free_time: 30 } } });
  };
  await expect(readCloudGenshinWallet(token, clean, { signal: abort.signal })).rejects.toBe(abort.signal.reason);
  const changed = new Error("fixture profile changed");
  await expect(readCloudGenshinWallet(token, clean, { verifyProfile: async () => { throw changed; } })).rejects.toBe(changed);
  expect(calls).toBe(0);
  for (const disconnect of [false, true]) {
    let valid = true;
    await expect(readCloudGenshinWallet(token, async () => {
      valid = false;
      if (disconnect) throw new Error("fixture aborted connection");
      return clean();
    }, { verifyProfile: async () => { if (!valid) throw changed; } })).rejects.toBe(changed);
  }
  expect(calls).toBe(1);
});
