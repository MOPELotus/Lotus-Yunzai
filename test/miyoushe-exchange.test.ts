import { expect, test } from "bun:test";
import type { ProfileAccountContext } from "@lotus-yunzai/account";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";
import { readMiyousheShopAddresses, readMiyousheShopBalance, submitMiyousheShopExchange }
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
