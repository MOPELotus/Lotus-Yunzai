import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runGameCheckinSequence } from "../lib/game-checkin-sequence.ts";
import type { ProfileRequestContext } from "../packages/account/index.ts";
import { createHoyoClient, GameCheckinChallengeError } from "../packages/hoyo-client/index.ts";
import { readCnGameCheckinInfo, submitCnGameCheckin, type CnGameCheckinSource } from "../packages/hoyo-client/game-checkin.ts";

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

test("内联人工验证保留相同的活动和角色，只转发一次准确的 v3 证明头", async () => {
  const source = fixture(routes[0]);
  const challenge = { risk_code: 375, gt: "fixture-gt", challenge: "source-challenge", success: 0 };
  const blocked = () => Response.json({ retcode: 0, data: challenge });
  let attempt: unknown;
  try {
    await submitCnGameCheckin(source, async () => blocked());
  } catch (error) {
    attempt = error;
  }
  expect(attempt).toBeInstanceOf(GameCheckinChallengeError);
  expect(attempt).toMatchObject({ reason: "risk", challenge: {
    captchaVersion: 3, gt: "fixture-gt", challenge: "source-challenge", success: 0,
  } });
  expect((attempt as GameCheckinChallengeError).message).not.toContain("source-challenge");
  await expect(readCnGameCheckinInfo(source, async () => blocked())).rejects.not.toBeInstanceOf(GameCheckinChallengeError);
  await expect(submitCnGameCheckin(source, async () => Response.json({ retcode: 0,
    data: { ...challenge, captcha_version: 4, captcha_id: "different-fixture" } })))
    .rejects.not.toBeInstanceOf(GameCheckinChallengeError);
  await expect(submitCnGameCheckin(source, async () =>
    Response.json({ retcode: 0, data: { ...challenge, uid: "100000016" } }))).rejects.toMatchObject({ code: "response" });
  const proof = { challenge: "sdk-returned-challenge", validate: "sdk-validation", seccode: "sdk-validation|jordan" };
  expect(await submitCnGameCheckin(source, async (url, request) => {
    expect(url.href).toBe("https://api-takumi.mihoyo.com/event/luna/sign");
    expect(JSON.parse(String(request.body))).toEqual({
      act_id: routes[0][5], uid: source.role.uid, region: source.role.region, lang: "zh-cn",
    });
    const headers = new Headers(request.headers);
    expect(headers.get("x-rpc-challenge")).toBe(proof.challenge);
    expect(headers.get("x-rpc-validate")).toBe(proof.validate);
    expect(headers.get("x-rpc-seccode")).toBe(proof.seccode);
    return Response.json({ retcode: 0, data: { is_risk: false } });
  }, { proof })).toBe("accepted");
  await expect(submitCnGameCheckin(source, async () => blocked(), { proof })).rejects.not.toBeInstanceOf(GameCheckinChallengeError);
  let calls = 0;
  await expect(submitCnGameCheckin(source, async () => { calls++; return blocked(); },
    { proof: { ...proof, seccode: "unrelated-fixture" } })).rejects.toMatchObject({ code: "invalid-input" });
  expect(calls).toBe(0);
});

const nxxSource = {
  ...fixture(routes[0]), game: "nxx",
  role: { ...fixture(routes[0]).role, uid: "734567890", region: "cn_prod_gf01", gameBiz: "nxx_cn" },
} satisfies CnGameCheckinSource;

const bh3Source = {
  ...fixture(routes[0]), game: "bh3",
  role: { ...fixture(routes[0]).role, uid: "734567890", region: "ios01", gameBiz: "bh3_cn" },
  account: { ...fixture(routes[0]).account, stoken: "unused-stoken-fixture", stokenCookie: "stoken=fixture" },
} satisfies CnGameCheckinSource;

test("崩坏3同一 UID 的三个国服区各自使用旧 Luna 活动读取、提交和回读", async () => {
  for (const region of ["ios01", "android01", "pc01"]) {
    const source = { ...bh3Source, role: { ...bh3Source.role, region } };
    const calls: string[] = [];
    const identity = { act_id: "e202306201626331", uid: source.role.uid, region };
    const transport: Parameters<typeof readCnGameCheckinInfo>[1] = async (url, init) => {
      calls.push(`${init.method} ${url.pathname}`);
      expect(url.origin).toBe("https://api-takumi.mihoyo.com");
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      const headers = new Headers(init.headers);
      expect(headers.get("Cookie")).toBe("cookie_token=fixture");
      expect(headers.get("x-rpc-signgame")).toBeNull();
      expect(headers.get("x-rpc-client_type")).toBe("5");
      expect(headers.get("x-rpc-challenge")).toBeNull();
      const role = { game_uid: identity.uid, region, game_biz: "bh3_cn" };
      if (init.method === "POST") {
        expect(url.search).toBe("");
        expect(JSON.parse(String(init.body))).toEqual(identity);
        return Response.json({ retcode: 0, data: { role } });
      }
      expect(Object.fromEntries(url.searchParams)).toEqual({ ...identity, lang: "zh-cn" });
      expect(init.body).toBeUndefined();
      return Response.json({ retcode: 0, data: { role, is_sign: calls.length === 3, first_bind: false } });
    };
    expect(await runGameCheckinSequence({
      readInfo: () => readCnGameCheckinInfo(source, transport),
      submit: () => submitCnGameCheckin(source, transport),
      verifyCurrent: async () => {},
    })).toMatchObject({ status: "signed" });
    expect(calls).toEqual(["GET /event/luna/info", "POST /event/luna/sign", "GET /event/luna/info"]);
  }
});

test("崩坏3渠道服与人工证明在发送前拒绝，风控与不同区服回包不能成为确认", async () => {
  let calls = 0;
  const transport = async () => { calls++; return Response.json({ retcode: 0 }); };
  for (const role of [
    ...["bb01", "hun01", "hun02", "yyb01", "", "overseas01"].map(region => ({ ...bh3Source.role, region })),
    { ...bh3Source.role, gameBiz: "bh3_global" }, { ...bh3Source.role, gameBiz: "" },
    { ...bh3Source.role, uid: "734567890&region=pc01" },
  ]) {
    const invalid = { ...bh3Source, role };
    await expect(readCnGameCheckinInfo(invalid, transport)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitCnGameCheckin(invalid, transport)).rejects.toMatchObject({ code: "invalid-input" });
  }
  await expect(submitCnGameCheckin(bh3Source, transport, {
    proof: { challenge: "fixture", validate: "fixture", seccode: "fixture|jordan" },
  })).rejects.toMatchObject({ code: "invalid-input" });
  expect(calls).toBe(0);

  const differentRegion = { game_uid: bh3Source.role.uid, region: "android01", game_biz: "bh3_cn" };
  await expect(readCnGameCheckinInfo(bh3Source, async () =>
    Response.json({ retcode: 0, data: { is_sign: true, role: differentRegion } }))).rejects.toMatchObject({ code: "response" });
  for (const retcode of [0, -5003]) {
    await expect(submitCnGameCheckin(bh3Source, async () =>
      Response.json({ retcode, data: { role: differentRegion } }))).rejects.toMatchObject({ code: "response" });
  }
  const risk = () => submitCnGameCheckin(bh3Source, async () => Response.json({
    retcode: 0, data: { gt_result: { risk_code: 375, gt: "fixture", challenge: "fixture-challenge" } },
  }));
  await expect(risk()).rejects.toMatchObject({ reason: "risk" });
  await expect(risk()).rejects.not.toBeInstanceOf(GameCheckinChallengeError);
});

test("未定事件簿国服按旧协议先读同角色状态，提交后只回读一次确认", async () => {
  for (const [before, after, actions, outcome] of [
    [{ is_sign: false, first_bind: false }, true, ["info", "sign", "info"], "signed"],
    [{ is_sign: false, first_bind: false }, false, ["info", "sign", "info"], "unconfirmed"],
    [{ is_sign: true, first_bind: false }, false, ["info"], "already"],
    [{ is_sign: false, first_bind: true }, false, ["info"], "first-bind"],
  ] as const) {
    const methods: string[] = [];
    const verify = async () => undefined;
    const transport = async (url: URL, init: RequestInit) => {
      expect(url.origin).toBe("https://api-takumi.mihoyo.com");
      const action = init.method === "POST" ? "sign" : "info";
      expect(url.pathname).toBe(`/event/luna/${action}`);
      methods.push(action);
      const identity = { act_id: "e202202251749321", uid: nxxSource.role.uid, region: "cn_prod_gf01" };
      const headers = new Headers(init.headers);
      expect(headers.get("Cookie")).toBe("cookie_token=fixture");
      expect(headers.get("x-rpc-signgame")).toBeNull();
      expect(headers.get("x-rpc-challenge")).toBeNull();
      expect(headers.get("x-rpc-client_type")).toBe("5");
      expect(init.redirect).toBe("error");
      if (action === "sign") {
        expect(url.search).toBe("");
        expect(JSON.parse(String(init.body))).toEqual(identity);
        return Response.json({ retcode: 0, data: { role: { game_uid: identity.uid, region: identity.region, game_biz: "nxx_cn" } } });
      }
      expect(init.body).toBeUndefined();
      expect(Object.fromEntries(url.searchParams)).toEqual({ ...identity, lang: "zh-cn" });
      return Response.json({ retcode: 0, data: {
        ...(methods.length > 1 ? { is_sign: after, first_bind: false } : before),
        role: { game_uid: Number(identity.uid), region: identity.region, game_biz: "nxx_cn" },
        total_sign_day: 5,
      } });
    };
    expect(await runGameCheckinSequence({
      readInfo: () => readCnGameCheckinInfo(nxxSource, transport, {}, verify),
      submit: () => submitCnGameCheckin(nxxSource, transport, {}, verify),
      verifyCurrent: verify,
    })).toMatchObject({ status: outcome });
    expect(methods).toEqual([...actions]);
  }
});

test("未定只接受目录确认的官方服角色，拒绝空区、渠道服、外服和跨档证明", async () => {
  let calls = 0;
  const transport = async () => { calls++; return Response.json({ retcode: 0 }); };
  for (const role of [
    { ...nxxSource.role, region: "cn_prod_mix01" },
    { ...nxxSource.role, region: "cn_prod_bb01" },
    { ...nxxSource.role, region: "" },
    { ...nxxSource.role, gameBiz: "" },
    { ...nxxSource.role, gameBiz: "nxx_global" },
    { ...nxxSource.role, uid: "734567890&region=cn_prod_gf01" },
  ]) {
    const invalid = { ...nxxSource, role };
    await expect(readCnGameCheckinInfo(invalid, transport)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitCnGameCheckin(invalid, transport)).rejects.toMatchObject({ code: "invalid-input" });
  }
  await expect(submitCnGameCheckin(nxxSource, transport, {
    proof: { challenge: "fixture-c", validate: "fixture-v", seccode: "fixture-v|jordan" },
  })).rejects.toMatchObject({ code: "invalid-input" });
  expect(calls).toBe(0);
});

test("未定状态失败和风控保留清楚分类，换绑中止后不再处理传输回包", async () => {
  const risk = { is_risk: true, gt: "fixture-gt", challenge: "fixture-challenge" };
  for (const [value, expected] of [
    [{ retcode: 0, data: risk }, { reason: "risk" }],
    [{ retcode: 0, data: { gt_result: risk } }, { reason: "risk" }],
    [{ retcode: 1034, data: risk }, { reason: "risk" }],
    [{ retcode: -100, message: "请先登录后参与活动（-100）" }, { reason: "expired" }],
    [{ retcode: -5003, data: { role_id: "765432109" } }, { code: "response" }],
    [{ retcode: 0, data: { region: "cn_prod_bb01" } }, { code: "response" }],
    [{ retcode: 0, data: true }, { code: "response" }],
  ] as const) {
    const reply = submitCnGameCheckin(nxxSource, async () => Response.json(value), {});
    await expect(reply).rejects.not.toBeInstanceOf(GameCheckinChallengeError);
    await expect(reply).rejects.toMatchObject(expected);
  }
  const changed = new Error("fixture profile changed");
  let valid = true;
  let calls = 0;
  await expect(submitCnGameCheckin(nxxSource, async () => {
    calls++;
    valid = false;
    throw new Error("fixture connection lost");
  }, {}, async () => {
    if (!valid) throw changed;
  })).rejects.toBe(changed);
  expect(calls).toBe(1);
});
