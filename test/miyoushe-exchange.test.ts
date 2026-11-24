import { expect, test } from "bun:test";
import type { ProfileAccountContext } from "@lotus-yunzai/account";
import { createManualCaptchaRelay } from "../lib/captcha/manual-relay.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";
import { readMiyousheShopAddresses, readMiyousheShopAccountQuota, readMiyousheShopBalance, submitMiyousheShopExchange }
  from "@lotus-yunzai/hoyo-client/miyoushe-exchange";

const profile: ProfileAccountContext = {
  qq: "42", profileId: 2, revision: "unused",
  account: { stuid: "123", ltuid: "123", mid: "fake-mid", stoken: "irrelevant-stoken", stokenCookie: "other-private-cookie",
    ltoken: "irrelevant-ltoken", cookie: "cookie_token_v2=v2_fixture;account_id_v2=123;account_mid_v2=fake-mid;stoken=forbidden;ltoken=not-sent" },
  device: { id: "fake-device-id", fp: "fake-device-fp", model: "Test Model", name: "测试设备", androidVersion: "15", raw: {} },
};
const virtual = { goodsId: "424242", type: 2, role: { uid: "77777777", gameBiz: "hk4e_cn", region: "cn_gf01" },
  gameBiz: "hk4e_cn", addressId: "" } as const;
const physical = { goodsId: "424244", type: 1, role: null, gameBiz: "", addressId: "86542" } as const;

test("商城余额和地址访问固定域名，只发当前档案 Cookie 授权并脱敏地址", async () => {
  let guards = 0;
  const verify = async () => { guards++; };
  const calls: string[] = [];
  const transport: HoyoTransport = async (url, init) => {
    calls.push(url.href);
    expect(new Headers(init.headers).get("cookie")).toBe("cookie_token_v2=v2_fixture; account_id_v2=123; account_mid_v2=fake-mid");
    expect(new Headers(init.headers).get("x-rpc-device_fp")).toBeNull();
    expect(init.redirect).toBe("error");
    expect(init.method).toBe("GET");
    if (url.pathname.includes("address")) return Response.json({ retcode: 0, data: {
      list: [{ id: "86542", connect_mobile: "13900001234", connect_name: "张三", addr_ext: "秘密地址" }],
    } });
    return Response.json({ retcode: 0, data: { points: "680" } });
  };
  expect(await readMiyousheShopBalance(transport, profile, undefined, verify)).toBe(680);
  expect(await readMiyousheShopAddresses(transport, profile, undefined, verify)).toEqual([{ id: "86542", label: "张** ****1234" }]);
  expect(guards).toBe(4);
  expect(calls).toEqual([
    "https://bbs-api.miyoushe.com/common/homutreasure/v1/web/user/point?app_id=1&point_sn=myb",
    "https://api-takumi.miyoushe.com/account/address/list?point_sn=myb",
  ]);
});

test("商城认证头使用账号内 Cookie，账号冲突和会话过期停止", async () => {
  let requests = 0;
  const transport: HoyoTransport = async (_endpoint, init) => {
    requests++;
    expect(new Headers(init.headers).get("cookie")).toBe("cookie_token=legacy-fixture; account_id=123");
    return Response.json({ retcode: -100, message: "private-raw-server-data" });
  };
  const source = { ...profile, account: { ...profile.account, cookie: "cookie_token=legacy-fixture;account_id=123;stoken=not-sent" } };
  await expect(readMiyousheShopBalance(transport, source)).rejects.toMatchObject({ reason: "expired", status: 409 });
  await expect(readMiyousheShopAddresses(transport, {
    ...source, account: { ...source.account, cookie: "cookie_token=legacy-fixture;account_id=999" },
  })).rejects.toMatchObject({ reason: "invalid", status: 400 });
  await expect(readMiyousheShopAddresses(transport, {
    ...source, account: { ...source.account, cookie: "cookie_token=first;cookie_token=second;account_id=123" },
  })).rejects.toMatchObject({ reason: "invalid", status: 400 });
  expect(requests).toBe(1);
});

test("商城兑换请求仅发送一件且死板限定域、商品、角色或地址", async () => {
  const bodies: unknown[] = [];
  let verified = false;
  const transport: HoyoTransport = async (url, init) => {
    expect(verified).toBe(true);
    expect(url.href).toBe("https://bbs-api.miyoushe.com/common/homushop/v1/web/goods/exchange");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe("cookie_token_v2=v2_fixture; account_id_v2=123; account_mid_v2=fake-mid");
    expect(headers.get("x-rpc-device_fp")).toBe("fake-device-fp");
    expect(headers.get("x-rpc-device_name")).toBe(encodeURIComponent(profile.device.name));
    expect(headers.get("x-rpc-challenge")).toBeNull();
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ retcode: 0, data: {} });
  };
  const verify = async () => { verified = true; };
  expect(await submitMiyousheShopExchange(transport, profile, virtual, undefined, verify)).toBe("succeeded");
  expect(await submitMiyousheShopExchange(transport, profile, physical, undefined, verify)).toBe("succeeded");
  await expect(submitMiyousheShopExchange(transport, profile, {
    ...virtual, role: { ...virtual.role, gameBiz: "bh3_cn" },
  })).rejects.toMatchObject({ reason: "invalid" });
  await expect(submitMiyousheShopExchange(transport, profile, physical, undefined, async () => {
    throw new Error("档案换绑");
  })).rejects.toThrow("档案换绑");
  expect(bodies).toEqual([
    { app_id: 1, point_sn: "myb", goods_id: "424242", exchange_num: 1, address_id: 0,
      uid: "77777777", region: "cn_gf01", game_biz: "hk4e_cn" },
    { app_id: 1, point_sn: "myb", goods_id: "424244", exchange_num: 1, address_id: 86542 },
  ]);
});

test("商城兑换区分验证、限流、业务拒绝和不明结果，完全不重试", async () => {
  const response = (retcode: number, status?: number) => Response.json({ retcode }, { status });
  const scenarios = [
    [() => response(1028), "verification"], [() => response(1034), "verification"],
    [() => response(429), "rate-limited"], [() => response(0, 429), "rate-limited"],
    [() => response(-10000), "failed"], [() => response(-999), "failed"],
    [() => response(0, 500), "unknown"], [() => new Response("invalid"), "unknown"],
    [() => { throw Error("请求后连接中断"); }, "unknown"],
  ] as const;
  for (const [next, expected] of scenarios) {
    let posts = 0;
    const transport: HoyoTransport = async () => { posts++; return next(); };
    expect(await submitMiyousheShopExchange(transport, profile, virtual)).toBe(expected);
    expect(posts).toBe(1);
  }
});

const v4Proof = { captchaVersion: 4, captchaId: "fixture-shop", lotNumber: "fixture-lot", captchaOutput: "fixture-output",
  passToken: "fixture-pass", genTime: "1760000000" } as const;

test("旧商城 v4 使用本机 GT Manual 一次性人工票据，其他浏览器不会重复领取", async () => {
  const origin = "https://shop-verify.example.invalid";
  const relay = createManualCaptchaRelay({ publicUrl: origin });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    return await relay.handlePublic(request) ?? new Response(null, { status: 404 });
  } });
  try {
    const scope = new AbortController();
    let purchases = 0;
    const transport: HoyoTransport = async (url) => {
      if (url.pathname.endsWith("/goods/exchange")) return Response.json({ retcode: ++purchases === 1 ? 1028 : 0 });
      if (url.pathname.endsWith("/createVerification")) return Response.json({ retcode: 0, data: { captcha_id: v4Proof.captchaId } });
      expect(url.pathname).toBe("/misc/wapi/verifyVerfication");
      expect(url.searchParams.get("lot_number")).toBe(v4Proof.lotNumber);
      return Response.json({ retcode: 0, data: { challenge: "official-fixture" } });
    };
    const verify = async () => { scope.signal.throwIfAborted(); };
    const outcome = await submitMiyousheShopExchange(transport, profile, virtual, scope.signal, verify, {
      async waitForProof(challenge, signal) {
        const registration = await relay.register(challenge, signal);
        expect(registration).toBeDefined();
        if (!registration) return;
        const link = new URL(registration.link);
        const publicFetch = (path: string, init?: RequestInit) => fetch(new URL(path, server.url), {
          ...init, headers: { Host: link.host, ...init?.headers },
        });
        const claim = link.pathname.replace("/GTest/", "/GTest/register/");
        const first = await publicFetch(claim);
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual(challenge);
        expect((await publicFetch(claim)).status).toBe(409);
        expect((await publicFetch(link.pathname.replace("/GTest/", "/GTest/validate/"), {
          method: "POST", body: JSON.stringify(v4Proof), headers: { Origin: origin, "Content-Type": "application/json" },
        })).status).toBe(200);
        const result = await relay.readResult(registration.ticket);
        expect(await relay.readResult(registration.ticket)).toEqual({ status: "unavailable" });
        if (result.status === "complete" && "captchaId" in result.result) return result.result;
      },
      prepareResume: verify,
    });
    expect(outcome).toBe("succeeded");
    expect(purchases).toBe(2);
  } finally {
    relay.close();
    server.stop(true);
  }
});

test("商城只在明确未购买后接受人工结果，官方核验后按原兑换目标提交一次", async () => {
  const orderBodies: string[] = [];
  const observed: string[] = [];
  const signal = new AbortController().signal;
  const verify = async () => { expect(signal.aborted).toBe(false); };
  const transport: HoyoTransport = async (url, init) => {
    const headers = new Headers(init.headers);
    expect(url.origin).toBe("https://bbs-api.miyoushe.com");
    expect(headers.get("cookie")).toBe("cookie_token_v2=v2_fixture; account_id_v2=123; account_mid_v2=fake-mid");
    expect(init.redirect).toBe("error");
    if (url.pathname.endsWith("/goods/exchange")) {
      orderBodies.push(String(init.body));
      if (orderBodies.length === 1) {
        observed.push("purchase");
        expect(headers.get("x-rpc-challenge")).toBeNull();
        return Response.json({ retcode: 1034 });
      }
      observed.push("resume");
      expect(headers.get("x-rpc-challenge")).toBe("verified-by-official-fixture");
      expect(headers.get("x-rpc-device_fp")).toBe("fake-device-fp");
      return Response.json({ retcode: 0 });
    }
    expect(headers.get("x-rpc-device_fp")).toBeNull();
    expect(headers.get("x-rpc-challenge")).toBeNull();
    if (init.method === "GET") {
      observed.push("create");
      expect(url.pathname).toBe("/misc/wapi/createVerification");
      expect(Object.fromEntries(url.searchParams)).toEqual({ point_sn: "myb", is_high: "true", captcha_version: "v4" });
      return Response.json({ retcode: 0, data: { captcha_id: "fixture-shop", risk_type: "slide", ignored: "fixture" } });
    }
    observed.push("verify-proof");
    expect(url.pathname).toBe("/misc/wapi/verifyVerfication");
    expect(Object.fromEntries(url.searchParams)).toEqual({ captcha_version: "v4", lot_number: "fixture-lot",
      captcha_output: "fixture-output", pass_token: "fixture-pass", gen_time: "1760000000" });
    expect(init.body).toBe('{"point_sn":"myb"}');
    return Response.json({ retcode: 0, data: { challenge: "verified-by-official-fixture" } });
  };
  const outcome = await submitMiyousheShopExchange(transport, profile, physical, signal, verify, {
    async waitForProof(challenge, scope) {
      observed.push("human");
      expect(scope).toBe(signal);
      expect(challenge).toEqual({ captchaVersion: 4, captchaId: "fixture-shop", riskType: "slide" });
      return v4Proof;
    },
    async prepareResume() { observed.push("recheck-original-order"); },
  });
  expect(outcome).toBe("succeeded");
  expect(observed).toEqual(["purchase", "create", "human", "verify-proof", "recheck-original-order", "resume"]);
  expect(orderBodies).toHaveLength(2);
  expect(orderBodies[1]).toBe(orderBodies[0]!);
  expect(JSON.parse(orderBodies[0]!)).toMatchObject({ goods_id: physical.goodsId, address_id: Number(physical.addressId), exchange_num: 1 });
});

test("限流、未知购买结果及非明确拒绝不能启动人工验证码", async () => {
  const options = {
    async waitForProof() { throw new Error("不应请求人工证明"); },
    async prepareResume() { throw new Error("不应准备重提"); },
  };
  for (const [makeResponse, expected] of [
    [() => Response.json({ retcode: 1028 }, { status: 503 }), "unknown"],
    [() => Response.json({ retcode: 1034, message: "请求频繁" }), "rate-limited"],
    [() => Response.json({ retcode: -123 }), "failed"],
    [() => { throw new Error("connection lost"); }, "unknown"],
  ] as const) {
    let dispatched = 0;
    const transport: HoyoTransport = async () => {
      dispatched++;
      return makeResponse();
    };
    expect(await submitMiyousheShopExchange(transport, profile, virtual, new AbortController().signal, async () => {}, options))
      .toBe(expected);
    expect(dispatched).toBe(1);
  }
});

test("不同挑战、退出或重检失败停止。续交结果未知时不再发起人工验证", async () => {
  for (const kind of ["wrong-proof", "logout", "authority-denied", "authority-missing-proof",
    "changed-target", "session-ended-before-resume", "unknown-second-post"] as const) {
    const controller = new AbortController();
    let purchase = 0;
    let checks = 0;
    let solves = 0;
    let readyToResume = false;
    const transport: HoyoTransport = async (url) => {
      if (url.pathname.endsWith("/goods/exchange")) {
        if (++purchase === 1) return Response.json({ retcode: 1028 });
        throw new Error("connection lost after dispatch");
      }
      if (url.pathname.endsWith("/createVerification")) {
        expect(url.searchParams.get("is_high")).toBe("false");
        return Response.json({ retcode: 0, data: { captcha_id: "fixture-shop" } });
      }
      checks++;
      if (kind === "authority-denied") return Response.json({ retcode: 10041 });
      if (kind === "authority-missing-proof") return Response.json({ retcode: 0, data: {} });
      return Response.json({ retcode: 0, data: { challenge: "verified-by-official-fixture" } });
    };
    const result = await submitMiyousheShopExchange(transport, profile, virtual, controller.signal, async () => {
      if (readyToResume && kind === "session-ended-before-resume") throw new Error("原网页会话已结束");
    }, {
      async waitForProof() {
        solves++;
        if (kind === "logout") controller.abort();
        return kind === "wrong-proof" ? { ...v4Proof, captchaId: "other-session" } : v4Proof;
      },
      async prepareResume() {
        if (kind === "changed-target") throw new Error("预约目标已变化");
        readyToResume = true;
      },
    });
    expect(result).toBe(kind === "unknown-second-post" ? "unknown" : "verification");
    expect(purchase).toBe(kind === "unknown-second-post" ? 2 : 1);
    expect(checks).toBe(kind === "wrong-proof" || kind === "logout" ? 0 : 1);
    expect(solves).toBe(1);
  }
});


test("账号限购只向固定商品详情读同档最小 Cookie，省略未验证的数字", async () => {
  let guards = 0, requests = 0;
  let data: Record<string, unknown> = { goods_id: "424242", account_cycle_type: "month",
    account_cycle_limit: "2", account_exchange_num: 2, otherPrivate: "not exposed" };
  const transport: HoyoTransport = async (url, init) => {
    requests++;
    expect(url.href).toBe("https://api-takumi.mihoyo.com/mall/v1/web/goods/detail?app_id=1&point_sn=myb&goods_id=424242");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("Origin")).toBe("https://user.mihoyo.com");
    expect(headers.get("Cookie")).toBe("cookie_token_v2=v2_fixture; account_id_v2=123; account_mid_v2=fake-mid");
    expect(headers.get("x-rpc-device_fp")).toBeNull();
    return Response.json({ retcode: 0, data });
  };
  const verify = async () => { guards++; };
  const read = () => readMiyousheShopAccountQuota(transport, profile, "424242", undefined, verify);
  expect(await read()).toEqual({ cycle: "month", limit: 2, used: 2 });
  expect(guards).toBe(2);
  data = { ...data, goods_id: "424243" };
  expect(await read()).toBeUndefined();
  data = { ...data, goods_id: "424242", account_exchange_num: undefined };
  expect(await read()).toBeUndefined();
  data = { ...data, account_exchange_num: 0 };
  expect(await read()).toEqual({ cycle: "month", limit: 2, used: 0 });
  const stopped = async () => { throw new Error("网页会话已撤销"); };
  await expect(readMiyousheShopAccountQuota(transport, profile, "424242", undefined, stopped)).rejects.toThrow("撤销");
  expect(requests).toBe(4);
  let checks = 0;
  const revokedInFlight = async () => { if (++checks === 2) throw new Error("网页会话已撤销"); };
  await expect(readMiyousheShopAccountQuota(transport, profile, "424242", undefined, revokedInFlight)).rejects.toThrow("撤销");
  expect(requests).toBe(5);
});

test("商城已授权的读取遇网络瞬断沿用同档重试并在每次请求前复核", async () => {
  let calls = 0, guards = 0;
  const seen = new Set<AbortSignal | null | undefined>();
  const transport: HoyoTransport = async (_url, init) => {
    calls++;
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("Cookie")).toBe("cookie_token_v2=v2_fixture; account_id_v2=123; account_mid_v2=fake-mid");
    seen.add(init.signal);
    if (calls < 3) throw new Error("合成短时断线");
    return Response.json({ retcode: 0, data: { points: 42 } });
  };
  expect(await readMiyousheShopBalance(transport, profile, undefined, async () => { guards++; })).toBe(42);
  expect(calls).toBe(3);
  expect(guards).toBe(4);
  expect(seen.size).toBe(1);
});

test("商城认证读遇业务限频、取消或换绑期间不会接着重试", async () => {
  let calls = 0;
  const rate: HoyoTransport = async () => {
    calls++;
    return Response.json({ retcode: 429 });
  };
  await expect(readMiyousheShopBalance(rate, profile)).rejects.toMatchObject({ reason: "rate-limited" });
  expect(calls).toBe(1);
  for (const mode of ["abort", "rebind"]) {
    const controller = new AbortController();
    const halted = new Error(mode);
    let changed = false;
    calls = 0;
    const fail: HoyoTransport = async () => {
      calls++;
      changed = true;
      if (mode === "abort") controller.abort(halted);
      throw new Error("合成短时断线");
    };
    await expect(readMiyousheShopBalance(fail, profile, controller.signal, async () => {
      if (changed) throw halted;
    })).rejects.toBe(halted);
    expect(calls).toBe(1);
  }
});

test("商城首次提交在最终账号核验期间关窗，传输层收到零请求", async () => {
  let open = true, calls = 0;
  const transport: HoyoTransport = async () => {
    calls++;
    return Response.json({ retcode: 0 });
  };
  const verify = async () => { open = false; };
  expect(await submitMiyousheShopExchange(transport, profile, virtual, undefined, verify, undefined, () => open)).toBe("missed");
  expect(calls).toBe(0);
});

test("商城自动验证码每次新建 v4 挑战，二次校验拒绝后不提前兑换", async () => {
  const { setDefaultCaptchaSolver } = await import("../packages/hoyo-client/captcha.ts");
  let creates = 0, accepts = 0, orders = 0;
  const signal = new AbortController().signal;
  setDefaultCaptchaSolver({ async run(options) {
    expect(options.allowManual).toBe(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const challenge = await options.challenge();
      if ("completed" in challenge) return { ok: true, value: challenge.completed };
      const result = await options.accept({ ...v4Proof, lotNumber: `fresh-lot-${attempt}` }, challenge);
      if (result.accepted) return { ok: true, value: result.value };
    }
    return { ok: false, reason: "rejected" };
  } });
  try {
    const transport: HoyoTransport = async (url, init) => {
      if (url.pathname.endsWith("/goods/exchange")) {
        orders++;
        if (orders === 1) return Response.json({ retcode: 1034 });
        expect(new Headers(init.headers).get("x-rpc-challenge")).toBe("new-rpc-challenge");
        return Response.json({ retcode: 0 });
      }
      if (url.pathname.endsWith("createVerification")) {
        creates++;
        return Response.json({ retcode: 0, data: { captcha_id: v4Proof.captchaId, risk_type: `signed-full-${creates}` } });
      }
      accepts++;
      expect(orders).toBe(1);
      return Response.json(accepts === 1 ? { retcode: 1034 } : { retcode: 0, data: { challenge: "new-rpc-challenge" } });
    };
    expect(await submitMiyousheShopExchange(transport, profile, physical, signal, async () => {}, {
      allowManual: false,
      async waitForProof() { throw new Error("后台不可人工验证"); },
      async prepareResume() {},
    })).toBe("succeeded");
    expect([creates, accepts, orders]).toEqual([2, 2, 2]);
  } finally { setDefaultCaptchaSolver(undefined); }
});
