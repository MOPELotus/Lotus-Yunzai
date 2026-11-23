import { expect, test } from "bun:test";
import { normalizeCloudZzzComboToken, readCloudZzzWallet } from "../packages/hoyo-client/cloud-zzz-wallet.ts";

const token = "ai=12;ci=1;oi=fixture-open;ct=fixture%2Btoken==;si=fixture-signature;bi=nap_cn";
const walletUrl = "https://cg-nap-api.mihoyo.com/nap_cn/cg/wallet/wallet/get?cost_method=0&get_type=0";

function wallet(data: unknown) {
  return Response.json({ retcode: 0, data });
}

test("只向官方绝区零钱包发送现成云会话凭据与已核对的 Android 参数", async () => {
  const steps: string[] = [];
  const result = await readCloudZzzWallet(` ${token} `, async (endpoint, request) => {
    steps.push("wallet");
    expect(endpoint.href).toBe(walletUrl);
    expect(request).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect(request.body).toBeUndefined();
    const headers = new Headers(request.headers);
    expect(Object.fromEntries(headers)).toEqual({
      accept: "application/json",
      "x-rpc-combo_token": token,
      "x-rpc-client_type": "2",
      "x-rpc-app_version": "3.3.0",
      "x-rpc-cg_game_biz": "nap_cn",
      "x-rpc-op_biz": "clgm_nap-cn",
    });
    return wallet({ free_time: { free_time: 0, send_freetime: 15, free_time_limit: 600 }, debug: token });
  }, { verifyProfile: async () => { steps.push("guard"); } });
  expect(result).toEqual({ freeTimeMinutes: 0, grantedMinutes: 15 });
  expect(steps).toEqual(["guard", "wallet", "guard"]);
  expect(normalizeCloudZzzComboToken(token)).toBe(token);
});

test("非完整云绝区零会话、其它 realm 及头注入在请求前拒绝", async () => {
  let calls = 0;
  const transport = async () => { calls++; return wallet({}); };
  const invalid = [
    "", "fixture-opaque", "cookie_token_v2=fixture", "x".repeat(8193),
    token.replace("bi=nap_cn", "bi=hk4e_cn"), token.replace("bi=nap_cn", "bi=nap_global"),
    token.replace(";si=fixture-signature", ""), token.replace("ci=1", "ci=-1"),
    token.replace("ct=fixture%2Btoken==", "ct=cookie_token=fixture"),
    token.replace(";ci=1", ";ci=1;bi=hk4e_cn"), token + ";bi=nap_cn",
    token + "\r\nCookie: fixture", token.replace(";ci=1", "; ci=1"),
  ];
  for (const input of invalid) {
    await expect(readCloudZzzWallet(input, transport)).rejects.toMatchObject({ code: "invalid-input" });
  }
  expect(calls).toBe(0);
});

test("剩余时长保留分钟单位，并区分真实零、缺字段和无效值", async () => {
  await expect(readCloudZzzWallet(token, async () => wallet({ free_time: { free_time: 50, send_freetime: "0" } })))
    .resolves.toEqual({ freeTimeMinutes: 50, grantedMinutes: 0 });
  for (const freeTime of [0, "0", 597, "597"]) {
    await expect(readCloudZzzWallet(token, async () => wallet({ free_time: { free_time: freeTime } })))
      .resolves.toEqual({ freeTimeMinutes: Number(freeTime) });
  }
  for (const data of [null, {}, { free_time: null }, { free_time: { send_freetime: 15 } }, { free_time: { free_time: null } }]) {
    await expect(readCloudZzzWallet(token, async () => wallet(data)))
      .rejects.toMatchObject({ code: "response", reason: "missing-balance" });
  }
  for (const data of [[], { free_time: [] }, ...[false, -1, 1.5, " ", "1e2", "9007199254740992"].map((value) => (
    { free_time: { free_time: value } }
  ))]) {
    await expect(readCloudZzzWallet(token, async () => wallet(data)))
      .rejects.toMatchObject({ code: "response", reason: "invalid-balance" });
  }
});

test("过期、HTTP 失败、风控、重定向和超长回复保持单次请求并隐藏上游细节", async () => {
  const secret = "fixture-private-provider-message";
  for (const [respond, result] of [
    [() => Response.json({ retcode: -100, message: secret, data: null }), { reason: "expired", retcode: -100 }],
    [() => new Response(secret, { status: 401 }), { code: "http", status: 401 }],
    [() => new Response(secret, { status: 429 }), { reason: "rate-limited" }],
    [() => new Response(secret, { headers: { "x-rpc-aigis": secret } }), { reason: "risk" }],
    [() => new Response(secret, { status: 503 }), { code: "http", status: 503 }],
    [() => Response.redirect("https://invalid.example/wallet", 307), { code: "http", status: 307 }],
    [() => Response.json({ retcode: 19, message: secret }), { code: "api", retcode: 19 }],
    [() => new Response(secret.repeat(6000)), { code: "response" }],
    [() => { throw new Error(secret); }, { code: "transport" }],
  ] as const) {
    let calls = 0;
    const pending = readCloudZzzWallet(token, async () => { calls++; return respond(); });
    await expect(pending).rejects.toMatchObject(result);
    await expect(pending).rejects.not.toThrow(secret);
    expect(calls).toBe(1);
  }
});

test("取消、连接替换或档案变更中止凭据使用", async () => {
  const session = new AbortController();
  session.abort();
  let calls = 0;
  const read = async () => { calls++; return wallet({ free_time: { free_time: 30 } }); };
  await expect(readCloudZzzWallet(token, read, { signal: session.signal })).rejects.toBe(session.signal.reason);
  const changed = new Error("fixture profile changed");
  const rejectProfile = async () => { throw changed; };
  await expect(readCloudZzzWallet(token, read, { verifyProfile: rejectProfile })).rejects.toBe(changed);
  expect(calls).toBe(0);

  let active = true;
  await expect(readCloudZzzWallet(token, async () => {
    active = false;
    return read();
  }, { verifyProfile: async () => { if (!active) await rejectProfile(); } })).rejects.toBe(changed);
  expect(calls).toBe(1);
});
