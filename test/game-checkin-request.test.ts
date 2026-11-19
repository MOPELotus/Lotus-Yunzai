import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProfileRequestContext } from "../packages/account/index.ts";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import { readCnGameCheckinInfo, submitCnGameCheckin } from "../packages/hoyo-client/game-checkin.ts";

const routes = [
  ["gs", "hk4e_cn", "cn_gf01", "100000015", "https://api-takumi.mihoyo.com/event/luna", "e202311201442471", "hk4e"],
  ["sr", "hkrpg_cn", "prod_qd_cn", "500000016", "https://api-takumi.mihoyo.com/event/luna/hkrpg", "e202304121516551", "hkrpg"],
  ["zzz", "nap_cn", "prod_gf_cn", "712345678", "https://act-nap-api.mihoyo.com/event/luna/zzz", "e202406242138391", "zzz"],
] as const;

function fixture([game, gameBiz, region, uid]: typeof routes[number]) {
  return {
    qq: "42", profileId: 2, game, revision: "fixture-version",
    role: { gameBiz, region, uid, nickname: "签到验收角色", chosen: true },
    account: { cookie: "cookie_token=fixture" },
    device: { id: "device-fixture-2", fp: "fixture-device-fp", model: "Fixture" },
  } as ProfileRequestContext;
}

test("三款游戏签到的活动、方法、身份和 Web DS 取固定官方路由与当前档案", async () => {
  for (const route of routes) {
    const [, gameBiz, region, uid, endpoint, act_id, signgame] = route;
    const source = fixture(route);
    const trace: string[] = [];
    const client = createHoyoClient(async (url, init) => {
      trace.push(`${init.method} ${url.pathname}`);
      expect(url.href.split("?")[0]).toBe(`${endpoint}/${init.method === "GET" ? "info" : "sign"}`);
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      const params = { act_id, uid, region, lang: "zh-cn" };
      if (init.method === "GET") {
        expect(Object.fromEntries(url.searchParams)).toEqual(params);
        expect(init.body).toBeUndefined();
      } else {
        expect(JSON.parse(String(init.body))).toEqual(params);
        expect(url.search).toBe("");
      }
      const headers = new Headers(init.headers);
      expect(headers.get("Cookie")).toBe("cookie_token=fixture");
      expect(headers.get("x-rpc-signgame")).toBe(signgame);
      expect(headers.get("x-rpc-device_id")).toBe("device-fixture-2");
      expect(headers.get("x-rpc-device_fp")).toBe("fixture-device-fp");
      const [time, nonce, hash] = headers.get("DS")!.split(",");
      expect(nonce).toMatch(/^[a-z0-9]{6}$/);
      expect(hash).toBe(createHash("md5").update(`salt=4751cb5557bfad5e249e58462c39fb0a&t=${time}&r=${nonce}`).digest("hex"));
      return Response.json({ retcode: 0, data: { is_sign: false, first_bind: false, total_sign_day: "6",
        role: { game_uid: Number(uid), region, game_biz: gameBiz } } });
    });
    expect(await client.fetchCnGameCheckinInfo(source)).toEqual({
      signed: false, firstBind: false, totalSignDays: 6, revision: source.revision, refreshedCookie: false,
    });
    expect(await client.submitCnGameCheckin(source)).toBe("accepted");
    expect(trace).toHaveLength(2);
  }
});

test("不向其他账号、国际服、未核实的绝区零渠道区服派发签到请求", async () => {
  let calls = 0;
  const transport = async () => { calls++; return Response.json({ retcode: 0 }); };
  const source = fixture(routes[2]);
  for (const role of [
    { ...source.role, region: "prod_qd_cn" }, { ...source.role, region: "prod_gf_jp" },
    { ...source.role, gameBiz: "nap_global" }, { ...source.role, uid: "1&sign=other" },
  ]) {
    await expect(submitCnGameCheckin({ ...source, role }, transport)).rejects.toMatchObject({ code: "invalid-input" });
  }
  const stopped = new AbortController();
  stopped.abort();
  await expect(submitCnGameCheckin(source, transport, { signal: stopped.signal })).rejects.toMatchObject({ code: "transport" });
  const changed = new Error("fixture profile changed");
  await expect(readCnGameCheckinInfo(source, transport, {}, async () => { throw changed; })).rejects.toBe(changed);
  expect(calls).toBe(0);
});

test("只接受已校验的角色状态，过期、风险、限流和已经提交各自可区分", async () => {
  const source = fixture(routes[0]);
  for (const [value, error] of [
    [{ retcode: 0, data: { is_sign: "false" } }, { code: "response" }],
    [{ retcode: 0, data: { is_sign: true, game_uid: "100000016" } }, { code: "response" }],
    [{ retcode: 0, data: { is_sign: false, region: "cn_qd01" } }, { code: "response" }],
    [{ retcode: 0, data: { is_sign: false, total_sign_day: 32 } }, { code: "response" }],
    [{ retcode: 0, data: { is_risk: true, success: 0 } }, { reason: "risk" }],
    [{ retcode: 0, data: { is_risk: false, success: 1 } }, { reason: "risk" }],
    [{ retcode: 10041 }, { reason: "risk" }],
    [{ retcode: -100 }, { reason: "expired" }],
    [{ retcode: -100, message: "请求过于频繁" }, { reason: "rate-limited" }],
  ] as const) {
    await expect(readCnGameCheckinInfo(source, async () => Response.json(value))).rejects.toMatchObject(error);
  }
  expect(await submitCnGameCheckin(source, async () => Response.json({ retcode: -5003 }))).toBe("already");
  await expect(submitCnGameCheckin(source, async () => new Response(null, { status: 401 })))
    .rejects.toMatchObject({ code: "http", status: 401 });
  await expect(submitCnGameCheckin(source, async () => new Response(null, { status: 429 })))
    .rejects.toMatchObject({ reason: "rate-limited" });
  await expect(submitCnGameCheckin(source, async () => Response.json({ retcode: 0 }, { headers: { "x-rpc-aigis": '{"session":"fixture"}' } })))
    .rejects.toMatchObject({ reason: "risk" });
  let calls = 0;
  await expect(submitCnGameCheckin(source, async () => { calls++; throw new Error("connection lost"); }))
    .rejects.toMatchObject({ code: "transport" });
  expect(calls).toBe(1);
});
