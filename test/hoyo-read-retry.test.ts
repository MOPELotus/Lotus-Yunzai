import { expect, test } from "bun:test";
import { withHoyoReadRetries } from "../packages/hoyo-client/read-retry.ts";
import { readMiyousheShop } from "../packages/hoyo-client/miyoushe-shop.ts";
import { withReadRetries } from "../packages/http/index.ts";

const endpoint = new URL("https://api-takumi.mihoyo.com/game_record/app/genshin/api/index");
test("临时连接失败和网关错误在原请求内恢复，最多三次", async () => {
  let calls = 0;
  const transport = withHoyoReadRetries(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    if (calls === 2) return new Response("gateway", { status: 503 });
    return Response.json({ retcode: 0 });
  });
  expect(withHoyoReadRetries(transport)).toBe(transport);
  expect(await (await transport(endpoint, {})).json()).toEqual({ retcode: 0 });
  expect(calls).toBe(3);
  calls = 0;
  const failed = withHoyoReadRetries(async () => { calls++; return new Response("bad gateway", { status: 502 }); });
  expect((await failed(endpoint, {})).status).toBe(502);
  expect(calls).toBe(3);
});

test("取消和档案变化立即停止，内部控制字段不传给fetch", async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport = withHoyoReadRetries(async (_url, init) => {
    expect(init).not.toHaveProperty("readRetryGuard");
    expect(init).not.toHaveProperty("readRetry");
    calls++;
    return new Response(null, { status: 503 });
  });
  await expect(transport(endpoint, { readRetryGuard: async () => { throw Error("profile changed"); } })).rejects.toThrow("profile changed");
  expect(calls).toBe(1);
  const pending = transport(endpoint, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toBeDefined();
  expect(calls).toBeLessThanOrEqual(2);
});

test("限流、凭据失效、业务拒绝和永久代理错误不自动重试", async () => {
  for (const status of [400, 401, 403, 404, 410, 429]) {
    let calls = 0;
    const request = withHoyoReadRetries(async () => { calls++; return Response.json({ retcode: -100 }, { status }); });
    expect((await request(endpoint, {})).status).toBe(status);
    expect(calls).toBe(1);
  }
  let calls = 0;
  const proxy = withHoyoReadRetries(async () => { calls++; throw Object.assign(new Error("proxy authentication"), { code: "ERR_PROXY_TUNNEL" }); });
  await expect(proxy(endpoint, {})).rejects.toMatchObject({ code: "ERR_PROXY_TUNNEL" });
  expect(calls).toBe(1);
  calls = 0;
  const cooling = withHoyoReadRetries(async () => { calls++; return new Response(null, { status: 503, headers: { "Retry-After": "60" } }); });
  expect((await cooling(endpoint, {})).status).toBe(503);
  expect(calls).toBe(1);
});

test("GET兑换、发Token、验证码证明、任务领取及所有普通POST不重放", async () => {
  const paths = ["/common/apicdkey/api/webExchangeCdkey", "/common/apicdkey/api/webExchangeCdkeyHyl",
    "/account/auth/api/getLTokenBySToken", "/auth/api/getCookieAccountInfoBySToken", "/post/api/getPostFull",
    "/apihub/api/getShareConf", "/hk4e_cg_cn/wallet/wallet/get", "/ajax.php", "/verify",
    "/misc/api/createVerification", "/misc/api/verifyVerification"];
  for (const path of paths) {
    let calls = 0;
    const request = withHoyoReadRetries(async () => { calls++; return new Response(null, { status: 503 }); });
    await request(new URL(path, endpoint), {});
    expect(calls).toBe(1);
  }
  let writes = 0;
  const write = withHoyoReadRetries(async () => { writes++; throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); });
  await expect(write(new URL("/apihub/app/api/signIn", endpoint), { method: "POST", body: '{"gids":"2"}' })).rejects.toThrow("reset");
  expect(writes).toBe(1);
});

test("抽卡授权的已登记只读POST可重试，其他来源同路径不放行", async () => {
  let calls = 0;
  const request = withHoyoReadRetries(async (_url, init) => {
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"game_uid":123}');
    calls++;
    return calls === 1 ? new Response(null, { status: 410, headers: { "Content-Type": "text/html" } }) : Response.json({ retcode: 0 });
  });
  expect((await request(new URL("https://api-takumi.mihoyo.com/binding/api/genAuthKey"), { method: "POST", body: '{"game_uid":123}' })).status).toBe(200);
  expect(calls).toBe(2);
  calls = 0;
  await request(new URL("https://fixture.invalid/binding/api/genAuthKey"), { method: "POST", body: '{"game_uid":123}' });
  expect(calls).toBe(1);
});

test("商城已有重试预算保持三次，不被统一层放大", async () => {
  let calls = 0;
  const request = withHoyoReadRetries(async () => { calls++; throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); });
  await expect(readMiyousheShop(request, "list", {})).rejects.toThrow("连接");
  expect(calls).toBe(3);
});

test("同一传输切换策略不会嵌套重试或绕过米游社写接口限制", async () => {
  let calls = 0;
  const base = async () => { calls++; return new Response(null, { status: 503 }); };
  const publicRead = withReadRetries(base);
  const hoyo = withHoyoReadRetries(publicRead);
  expect(withHoyoReadRetries(hoyo)).toBe(hoyo);
  await hoyo(new URL("/common/apicdkey/api/webExchangeCdkey", endpoint), {});
  expect(calls).toBe(1);
  calls = 0;
  await withReadRetries(publicRead, { attempts: 2 })(endpoint, {});
  expect(calls).toBe(2);
});

test("JSON正文中途断连可重读，完整但错误的JSON不重复请求", async () => {
  let calls = 0;
  const request = withHoyoReadRetries(async () => {
    if (++calls > 1) return Response.json({ retcode: 0, data: { list: [] } });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"retcode":0,"data":'));
        setTimeout(() => controller.error(Object.assign(new Error("reset"), { code: "ECONNRESET" })), 10);
      },
    }), { headers: { "Content-Type": "application/json" } });
  });
  expect(await (await request(endpoint, {})).json()).toEqual({ retcode: 0, data: { list: [] } });
  expect(calls).toBe(2);
  calls = 0;
  const invalid = withHoyoReadRetries(async () => { calls++; return new Response("not-json", { headers: { "Content-Type": "application/json" } }); });
  await expect((await invalid(endpoint, {})).json()).rejects.toBeDefined();
  expect(calls).toBe(1);
});
