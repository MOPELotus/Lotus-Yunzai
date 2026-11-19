import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, type ProfileRequestContext } from "../packages/account/index.ts";
import { HoyoRequestError } from "../packages/hoyo-client/errors.ts";
import { genshinGachaPools, readGenshinGacha } from "../packages/hoyo-client/genshin-gacha.ts";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";

const uid = "512345678";
const otherUid = "123456789";
const region = "cn_qd01";
const cookie = "stoken=v2_fixture;stuid=8080;mid=fixture-mid;ltoken_v2=v2_fixture-ltoken";
const authkey = "fixture+%/key?=";
const options = { intervalMs: 0 };
const authPath = "/binding/api/genAuthKey";

function success(data: unknown) {
  return Response.json({ retcode: 0, data });
}

async function profile(run: (context: ProfileRequestContext, profiles: ReturnType<typeof createProfileStore>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-genshin-gacha-api-"));
  try {
    await writeFile(join(directory, "42-2.yaml"), `
version: 1
user: { qq: "42" }
profile: { id: 2 }
account:
  cookie: "account_id_v2=8080;account_mid_v2=fixture-mid;cookie_token_v2=v2_fixture-cookie"
  stoken: v2_fixture
  stoken_cookie: "${cookie}"
  stuid: "8080"
  game_roles:
    gs: [{ uid: "${otherUid}", region: cn_gf01 }, { game_uid: "${uid}", game_biz: hk4e_cn }]
  current_uid: { gs: "${uid}" }
device: { id: fixture-device, fp: fixture-fp, android_version: "14", name: Fixture, model: Fixture-Model }
`);
    const profiles = createProfileStore(directory);
    await run(await profiles.requestContext("42", 2, "gs"), profiles);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("只在官方换令牌接口确认档案过期时刷新，逐抽接口失效码不改档案", () => profile(async (source, profiles) => {
  let refreshes = 0;
  let authRequests = 0;
  let failHistory = false;
  const newStokenCookie = cookie.replace("v2_fixture-ltoken", "v2_refreshed-ltoken");
  const client = createHoyoClient(async (url, init) => {
    if (url.pathname === authPath) {
      authRequests++;
      const sent = new Headers(init.headers).get("Cookie");
      if (sent === cookie) return Response.json({ retcode: -100 });
      expect(sent).toBe(newStokenCookie);
      return success({ authkey, game_uid: uid, region });
    }
    return failHistory ? Response.json({ retcode: -100 }) : success({ list: [] });
  }, {
    profiles,
    async exchange(current) {
      refreshes++;
      expect([current.qq, current.profileId, current.revision]).toEqual(["42", 2, source.revision]);
      return {
        cookie: "account_id_v2=8080;account_mid_v2=fixture-mid;cookie_token_v2=v2_refreshed-cookie",
        ltoken: "v2_refreshed-ltoken",
        stokenCookie: newStokenCookie,
      };
    },
  });
  const result = await client.fetchGenshinGacha(source, options);
  const latest = await profiles.requestContext("42", 2, "gs");
  expect(result).toMatchObject({ uid, region, revision: latest.revision, refreshedCookie: true });
  expect(result.pools.map(({ type }) => type)).toEqual([301, 302, 500, 200]);
  expect([authRequests, refreshes]).toEqual([2, 1]);

  failHistory = true;
  await expect(client.fetchGenshinGacha(latest, options)).rejects.toMatchObject({ code: "api", retcode: -100 });
  expect([authRequests, refreshes]).toEqual([3, 1]);
  expect((await profiles.accountContext("42", 2)).revision).toBe(latest.revision);
}));

test("原神国服链按档案读取四池，保留精确游标与 400 记录", () => profile(async (context) => {
  const firstId = "1735853810000001922";
  const lastId = "1735853810000001921";
  const calls: string[] = [];
  let guards = 0;
  const result = await readGenshinGacha(context, async (url, init) => {
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    if (url.pathname === authPath) {
      calls.push("auth");
      expect(url.origin).toBe("https://api-takumi.mihoyo.com");
      expect(url.search).toBe("");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ auth_appid: "webview_gacha", game_biz: "hk4e_cn", game_uid: Number(uid), region });
      expect(headers.get("cookie")).toBe(cookie);
      expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
      expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
      expect(headers.get("x-rpc-device_model")).toBe("Fixture-Model");
      expect(headers.get("x-rpc-sys_version")).toBe("14");
      const [time, nonce, signature] = headers.get("DS")!.split(",");
      expect(time).toMatch(/^\d{10}$/u);
      expect(nonce).toMatch(/^[a-z0-9]{6}$/u);
      expect(signature).toBe(createHash("md5").update(`salt=7a047e46eadd8693f09513e55bdf6bd8&t=${time}&r=${nonce}`).digest("hex"));
      return Response.json({ retcode: "0", data: { authkey, region, game_uid: uid, game_biz: "hk4e_cn" } });
    }
    expect(url.origin).toBe("https://public-operation-hk4e.mihoyo.com");
    expect(url.pathname).toBe("/gacha_info/api/getGachaLog");
    expect(init.method).toBe("GET");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("ds")).toBe(false);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ authkey, game_biz: "hk4e_cn", region,
      init_type: "301", authkey_ver: "1", auth_appid: "webview_gacha", sign_type: "2", size: "20", lang: "zh-cn" });
    const pool = url.searchParams.get("gacha_type");
    const page = url.searchParams.get("page");
    const cursor = url.searchParams.get("end_id");
    calls.push(`${pool}/${page}/${cursor}`);
    if (pool === "301" && page === "1") {
      return success({ region, list: [{ id: firstId, uid, gacha_type: "301", name: "夹具角色", rank_type: "5" },
        { id: `0${lastId}`, uid: Number(uid), gacha_type: 400, name: "另一角色" }] });
    }
    if (pool === "302" && page === "1") return success({ list: [{ id: 123, uid, gacha_type: "302" }] });
    return success({ list: [] });
  }, options, async () => { guards++; });
  expect(calls).toEqual(["auth", "301/1/0", `301/2/${lastId}`, "302/1/0", "302/2/123", "500/1/0", "200/1/0"]);
  expect(guards).toBe(calls.length + 1);
  expect(result).toEqual({ uid, region, pools: [
    { ...genshinGachaPools[0], records: [{ id: firstId, uid, gacha_type: "301", name: "夹具角色", rank_type: "5" },
      { id: lastId, uid, gacha_type: "400", name: "另一角色" }] },
    { ...genshinGachaPools[1], records: [{ id: "123", uid, gacha_type: "302" }] },
    { ...genshinGachaPools[2], records: [] }, { ...genshinGachaPools[3], records: [] },
  ] });
}));

test("地区、角色游戏或档案登录身份冲突在发出请求前结束", () => profile(async (source) => {
  let count = 0;
  const request = async () => { count++; return success({ authkey }); };
  for (const context of [
    { ...source, role: { ...source.role, region: "cn_gf01" } },
    { ...source, role: { ...source.role, uid: "612345678", region: "cn_gf01" } },
    { ...source, role: { ...source.role, region: "os_usa" } },
    { ...source, role: { ...source.role, gameBiz: "hk4e_global" } },
    { ...source, account: { ...source.account, cookie: "account_id=99" } },
    { ...source, account: { ...source.account, stokenCookie: `${cookie};stuid=99` } },
    { ...source, account: { ...source.account, stokenCookie: `${cookie};stoken=other` } },
  ]) {
    await expect(readGenshinGacha(context, request, options)).rejects.toMatchObject({ code: "invalid-input" });
  }
  expect(count).toBe(0);
}));

test("四池读遇到其他账号、错误池、非精确编号或重复游标时整次失败", () => profile(async (context) => {
  const base = { id: "1735853810000001920", uid, gacha_type: "301" };
  for (const row of [{ ...base, uid: otherUid }, { ...base, gacha_type: "302" }, { ...base, id: Number(base.id) },
    { ...base, id: "-1" }, { ...base, id: "0" }]) {
    await expect(readGenshinGacha(context, async (url) => url.pathname === authPath
      ? success({ authkey }) : success({ list: [row] }), options)).rejects.toMatchObject({ code: "response" });
  }
  await expect(readGenshinGacha(context, async (url) => url.pathname === authPath
    ? success({ authkey }) : success({ list: [base] }), options)).rejects.toThrow("下一页游标无效");
  await expect(readGenshinGacha(context, async (url) => url.pathname === authPath
    ? success({ authkey }) : success({ region: "cn_gf01", list: [] }), options)).rejects.toMatchObject({ code: "response" });
  await expect(readGenshinGacha(context, async (url) => url.pathname === authPath
    ? success({ authkey }) : success({ list: [base] }), { intervalMs: 0, maxPages: 1 })).rejects.toThrow("超过分页上限");
}));

test("登录过期码可交给客户端续期，传输与档案变更不会泄漏凭据", () => profile(async (context) => {
  await expect(readGenshinGacha(context, async () => Response.json({ retcode: "-100", message: authkey }), options))
    .rejects.toMatchObject({ code: "api", retcode: -100, message: "原神抽卡接口拒绝请求。" });
  await expect(readGenshinGacha(context, async () => { throw new Error(cookie); }, options))
    .rejects.toMatchObject({ code: "transport", message: "原神抽卡请求未完成。" });
  await expect(readGenshinGacha(context, async () => success({ authkey, game_uid: otherUid }), options))
    .rejects.toMatchObject({ code: "response" });
  let requests = 0;
  let guards = 0;
  await expect(readGenshinGacha(context, async () => { requests++; return success({ authkey }); }, options, async () => {
    if (++guards === 2) throw new HoyoRequestError("profile-changed", "档案已变更。");
  })).rejects.toMatchObject({ code: "profile-changed" });
  expect(requests).toBe(1);
  const aborted = AbortSignal.abort();
  await expect(readGenshinGacha(context, async () => { requests++; return success({ authkey }); }, { signal: aborted }))
    .rejects.toMatchObject({ code: "transport" });
  expect(requests).toBe(1);
}));
