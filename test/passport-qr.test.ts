import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createPassportQr } from "../packages/hoyo-client/passport-qr.ts";

const ticket = "synthetic-passport-ticket";
const origin = "https://passport-api.mihoyo.com/account/ma-cn-passport/app/";
const qrOrigin = "https://user.mihoyo.com/login-platform/mobile.html";
const device = { id: "synthetic-device", fp: "synthetic-fp", name: "Example", model: "Example Pro", androidVersion: "12" };
const confirmed = {
  status: "Confirmed", user_info: { aid: "9223372036854775807", uid: "9223372036854775807", mid: "fixture-mid" },
  tokens: [{ token_type: 1, token: "v2_synthetic-stoken" }, { token_type: 2, name: "ltoken_v2", token: "unused-ltoken" }],
};

function ok(data: unknown) {
  return Response.json({ retcode: 0, data });
}

function qrData(useTicket = ticket) {
  const expiry = Math.floor(Date.now() / 1000) + 120;
  return { ticket: useTicket, url: `${qrOrigin}?expire=${expiry}&tk=${useTicket}&token_types=1#/login/qr` };
}

test("Passport App 只发官方 POST，创建和各次查询用同一档案设备及签名", async () => {
  const originalDevice = { ...device };
  const steps = [qrData(), { status: "Created" }, { stat: "Scanned" }, { status: "ScannedWaitingConfirmation" }, confirmed];
  const qr = createPassportQr(async (endpoint, init) => {
    const start = steps.length === 5;
    expect(endpoint.href).toBe(`${origin}${start ? "createQRLogin" : "queryQRLoginStatus"}`);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", proxy: false });
    expect(init.body).toBe(start ? "{}" : JSON.stringify({ ticket }));
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-rpc-device_id")).toBe(device.id);
    expect(headers.get("x-rpc-device_fp")).toBe(device.fp);
    expect(headers.get("x-rpc-device_name")).toBe(device.name);
    expect(headers.get("x-rpc-device_model")).toBe(device.model);
    expect(headers.get("x-rpc-app_id")).toBe("bll8iq97cem8");
    const [time, nonce, digest] = headers.get("DS")!.split(",");
    expect(digest).toBe(createHash("md5")
      .update(`salt=JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS&t=${time}&r=${nonce}&b=${init.body}&q=`).digest("hex"));
    return ok(steps.shift());
  });
  const session = await qr.create(originalDevice);
  originalDevice.id = "changed-outside-active-session";
  expect(new URL(session.url).searchParams.get("tk")).toBe(ticket);
  expect(session.expiresAt).toBe(Number(new URL(session.url).searchParams.get("expire")) * 1000);
  expect(Object.keys(session).sort()).toEqual(["expiresAt", "url"]);
  expect(await qr.poll(session)).toEqual({ status: "created" });
  expect(await qr.poll(session)).toEqual({ status: "scanned" });
  expect(await qr.poll(session)).toEqual({ status: "scanned" });
  const result = await qr.poll(session);
  expect(result).toEqual({ status: "confirmed", credentials: {
    stuid: "9223372036854775807", stoken: "v2_synthetic-stoken", mid: "fixture-mid",
  } });
  await expect(qr.poll(session)).rejects.toMatchObject({ reason: "invalid-session" });
  expect(steps).toHaveLength(0);
});

test("二维码地址须属官方扫码页，拒绝网页令牌族和不一致或重复的票据", async () => {
  for (const data of [
    { ticket, url: `https://evil.invalid/login-platform/mobile.html?tk=${ticket}` },
    { ticket, url: `https://account@user.mihoyo.com/login-platform/mobile.html?tk=${ticket}` },
    { ticket, url: `https://user.mihoyo.com/unrelated?tk=${ticket}` },
    { ticket, url: `${qrOrigin}?ticket=wrong-ticket` },
    { ticket, url: `${qrOrigin}?tk=${ticket}&ticket=${ticket}` },
    { ticket, url: `${qrOrigin}?tk=${ticket}&token_types=4` },
    { ticket, url: `${qrOrigin}?tk=${ticket}#/unrelated` },
    { ticket, url: `${qrOrigin}?tk=${ticket}&expire=1e12` },
  ]) {
    const qr = createPassportQr(async () => ok(data));
    await expect(qr.create(device)).rejects.toMatchObject({ reason: "response" });
  }
  const legacy = createPassportQr(async () => ok({ url: `${qrOrigin}?ticket=${ticket}` }));
  expect(await legacy.create({ id: "fixture-no-fp" })).toEqual({ url: `${qrOrigin}?ticket=${ticket}` });
  const oldDate = createPassportQr(async () => ok({ ticket, url: `${qrOrigin}?expire=1600000000&tk=${ticket}` }));
  await expect(oldDate.create(device)).rejects.toMatchObject({ reason: "expired" });
});

test("确认拒绝账号别名不一致、无 v2 MID 和混淆的 SToken", async () => {
  for (const data of [
    { ...confirmed, user_info: { ...confirmed.user_info, account_id: "42" } },
    { ...confirmed, user_info: { aid: confirmed.user_info.aid } },
    { ...confirmed, tokens: [{ name: "stoken", token_type: 2, token: "fixture-secret" }] },
    { ...confirmed, tokens: [{ name: "ltoken", token_type: 1, token: "fixture-secret" }] },
    { ...confirmed, tokens: [{ name: "stoken", token: "fixture-secret\r\n" }] },
    { ...confirmed, tokens: [{ token_type: 1, token: "fixture-secret" }, { name: "stoken", token: "another" }] },
  ]) {
    const qr = createPassportQr(async (url) => ok(url.pathname.endsWith("createQRLogin") ? qrData() : data));
    const session = await qr.create(device);
    const error = await qr.poll(session).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ reason: "response" });
    expect(String(error)).not.toContain("fixture-secret");
    await expect(qr.poll(session)).rejects.toMatchObject({ reason: "invalid-session" });
  }
  const legacy = createPassportQr(async (url) => ok(url.pathname.endsWith("createQRLogin") ? qrData() : {
    status: "Confirmed", user_info: { account_id: 42 }, tokens: [{ name: "stoken", token: "fixture-v1" }],
  }));
  expect(await legacy.poll(await legacy.create(device))).toEqual({
    status: "confirmed", credentials: { stuid: "42", stoken: "fixture-v1" },
  });
});

test("扫码过期和取消均终结票据，实名、验证、限频和过大响应停止处理", async () => {
  for (const [retcode, status] of [[-3501, "expired"], [-3505, "cancelled"]] as const) {
    const qr = createPassportQr(async (url) => url.pathname.endsWith("createQRLogin")
      ? ok(qrData()) : Response.json({ retcode, data: null }));
    const session = await qr.create(device);
    expect(await qr.poll(session)).toEqual({ status });
    await expect(qr.poll(session)).rejects.toMatchObject({ reason: "invalid-session" });
  }
  const cases = [
    [ok({ ...confirmed, realname_info: { required: true } }), "realname"],
    [Response.json({ retcode: 1034, message: "secret-upstream-text" }), "risk"],
    [Response.json({ retcode: 0, data: confirmed }, { headers: { "x-rpc-aigis": "secret-upstream-text" } }), "risk"],
    [new Response("secret-upstream-text", { status: 429 }), "rate-limited"],
    [new Response("s".repeat(33 * 1024)), "response"],
  ] as const;
  for (const [response, reason] of cases) {
    let polls = 0;
    const qr = createPassportQr(async (url) => {
      if (url.pathname.endsWith("createQRLogin")) return ok(qrData());
      polls++;
      return response;
    });
    const session = await qr.create(device);
    const error = await qr.poll(session).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ reason });
    expect(String(error)).not.toContain("secret-upstream-text");
    await expect(qr.poll(session)).rejects.toMatchObject({ reason: "invalid-session" });
    expect(polls).toBe(1);
  }
});

test("会话只归创建的客户端，单票据不并发查询，取消后迟到确认被丢弃", async () => {
  const { promise, resolve } = Promise.withResolvers<Response>();
  let calls = 0;
  const qr = createPassportQr(async (url) => {
    calls++;
    return url.pathname.endsWith("createQRLogin") ? ok(qrData()) : promise;
  });
  const session = await qr.create(device);
  const controller = new AbortController();
  const pending = qr.poll(session, { signal: controller.signal });
  await expect(qr.poll(session)).rejects.toMatchObject({ reason: "busy" });
  await expect(qr.poll({ ...session })).rejects.toMatchObject({ reason: "invalid-session" });
  await expect(createPassportQr(async () => { throw new Error("never called"); }).poll(session))
    .rejects.toMatchObject({ reason: "invalid-session" });
  controller.abort(new Error("secret abort reason"));
  resolve(ok(confirmed));
  await expect(pending).rejects.toMatchObject({ reason: "aborted", message: "扫码登录已停止。" });
  await expect(qr.poll(session)).rejects.toMatchObject({ reason: "invalid-session" });
  await expect(qr.create(device, { signal: controller.signal })).rejects.toMatchObject({ reason: "aborted" });
  await expect(qr.create({ id: "invalid\rheader" })).rejects.toMatchObject({ reason: "invalid-device" });
  expect(calls).toBe(2);
});
