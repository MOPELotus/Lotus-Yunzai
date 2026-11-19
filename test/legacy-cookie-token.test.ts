import { expect, test } from "bun:test";
import { verifyLegacyCookieToken } from "../packages/hoyo-client/legacy-cookie-token.ts";

const input = { accountId: "9007199254740991", cookieToken: "fixture+/V1==" };
const endpoint = "https://passport-api.mihoyo.com/account/ma-cn-session/web/verifyCookieToken";

function verified(aid: unknown) {
  return Response.json({ retcode: 0, data: { user_info: { aid, extra_field: input.cookieToken } } });
}

test("国服 v1 只向固定通行证接口提交该 Cookie Token，返回结果只含回验的账号 UID", async () => {
  const calls: string[] = [];
  for (const aid of [input.accountId, Number(input.accountId)]) {
    const proof = await verifyLegacyCookieToken(input, async (url, init) => {
      calls.push(url.href);
      expect(init).toMatchObject({ method: "POST", body: "{}", credentials: "omit", redirect: "error" });
      const headers = new Headers(init.headers);
      expect(headers.get("Cookie")).toBe(`account_id=${input.accountId}; cookie_token=${input.cookieToken}`);
      expect(headers.get("x-rpc-app_id")).toBe("dw9y09jqjpxc");
      expect(headers.get("Origin")).toBe("https://user.mihoyo.com");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return verified(aid);
    });
    expect(proof).toEqual({ accountId: input.accountId });
  }
  expect(calls).toEqual([endpoint, endpoint]);
});

test("v2、非法通行证 UID 及 Cookie 分隔符在发送请求前拒绝", async () => {
  const invalid = [
    { ...input, accountId: "0" }, { ...input, accountId: "01" },
    { ...input, accountId: "9007199254740992" }, { ...input, accountId: "+7" },
    { ...input, cookieToken: "v2_fixture" }, { ...input, cookieToken: "fixture;other=x" },
    { ...input, cookieToken: "fixture\r\n" }, { ...input, cookieToken: "" },
  ];
  let calls = 0;
  for (const credentials of invalid) {
    await expect(verifyLegacyCookieToken(credentials, async () => {
      calls++;
      return verified(input.accountId);
    })).rejects.toMatchObject({ code: "invalid-input" });
  }
  expect(calls).toBe(0);
});

test("通行证成功必须明确确认同一个 data.user_info.aid", async () => {
  for (const data of [
    null,
    { list: [{ game_uid: input.accountId }] },
    { user_info: { uid: input.accountId } },
    { user_info: { aid: "25" } },
    { user_info: { aid: `${input.accountId}\n` } },
    { user_info: { aid: 9007199254740992 } },
  ]) {
    await expect(verifyLegacyCookieToken(input, async () => Response.json({ retcode: 0, data })))
      .rejects.toMatchObject({ code: "response" });
  }
});

test("网络、HTTP、官方拒绝、风控和无效 JSON 均不会重试或透出源内容", async () => {
  for (const [respond, code] of [
    [() => { throw new Error(input.cookieToken); }, "transport"],
    [() => Response.redirect("https://example.invalid/"), "http"],
    [() => new Response(input.cookieToken, { status: 503 }), "http"],
    [() => Response.json({ retcode: -100, message: input.cookieToken }), "api"],
    [() => Response.json({ retcode: 0, data: { user_info: { aid: input.accountId } } }, {
      headers: { "x-rpc-aigis": input.cookieToken },
    }), "api"],
    [() => Response.json({ retcode: "0", data: { user_info: { aid: input.accountId } } }), "response"],
    [() => new Response(input.cookieToken), "response"],
  ] as const) {
    let calls = 0;
    let error: unknown;
    try {
      await verifyLegacyCookieToken(input, async () => {
        calls++;
        return respond();
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(input.cookieToken);
    expect(calls).toBe(1);
  }
});

test("有无 Content-Length 都须限制响应大小并取消流", async () => {
  for (const contentLength of [undefined, "32769"]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(18000));
        controller.enqueue(new Uint8Array(18000));
      },
      cancel() { cancelled = true; },
    });
    await expect(verifyLegacyCookieToken(input, async () => new Response(body, {
      headers: contentLength ? { "Content-Length": contentLength } : undefined,
    }))).rejects.toMatchObject({ code: "response" });
    expect(cancelled).toBe(true);
  }
});

test("调用取消后不发请求，读取已开始时取消停滞的响应流", async () => {
  const controller = new AbortController();
  const pendingRead = Promise.withResolvers<void>();
  let cancelled = false;
  let calls = 0;
  const wait = verifyLegacyCookieToken(input, async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      pull() { pendingRead.resolve(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
  }, { signal: controller.signal });
  await pendingRead.promise;
  controller.abort();
  await expect(wait).rejects.toMatchObject({ code: "transport" });
  await expect(verifyLegacyCookieToken(input, async () => {
    calls++;
    return verified(input.accountId);
  }, { signal: controller.signal })).rejects.toMatchObject({ code: "transport" });
  expect(cancelled).toBe(true);
  expect(calls).toBe(1);
});
