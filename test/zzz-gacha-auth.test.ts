import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, type ProfileRequestContext } from "../packages/account/index.ts";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import { HoyoRequestError } from "../packages/hoyo-client/errors.ts";
import { isZzzGachaAuthExpired, readZzzGachaAuthKey } from "../packages/hoyo-client/zzz-gacha-auth.ts";
import { parseZzzGachaLink } from "../packages/hoyo-client/zzz-gacha-link.ts";

const uid = "600000002";
const region = "prod_qd_cn";
const cookie = "stoken=v2_fixture;stuid=8080;mid=test-mid;ltoken_v2=v2_fixture-ltoken";
const key = "fixture+%/zzz?token=";
const auth = "https://api-takumi.mihoyo.com/binding/api/genAuthKey";
const history = "https://public-operation-common.mihoyo.com/common/gacha_record/api/getGachaLog";

function success(extra: object = {}) {
  return Response.json({ retcode: 0, data: { authkey: key, ...extra } });
}

async function profile(run: (source: ProfileRequestContext, profiles: ReturnType<typeof createProfileStore>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-zzz-gacha-auth-"));
  try {
    await writeFile(join(directory, "42-2.yaml"), `
version: 1
user: { qq: "42" }
profile: { id: 2 }
account:
  cookie: "account_id_v2=8080;account_mid_v2=test-mid;cookie_token_v2=v2_fixture-cookie"
  stoken: v2_fixture
  stoken_cookie: "${cookie}"
  stuid: "8080"
  game_roles:
    zzz: [{ uid: "100000003", region: prod_gf_cn, game_biz: nap_cn }, { uid: "${uid}", region: ${region}, game_biz: nap_cn }]
  current_uid: { zzz: "${uid}" }
device: { id: fixture-device, fp: fixture-fp, android_version: "14", name: Fixture, model: Fixture-Model }
`);
    const profiles = createProfileStore(directory);
    await run(await profiles.requestSelectedContext("42", 2, "zzz"), profiles);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("档案国服授权 POST 严格绑定已选绝区零角色，只向官方接口传本档案 STOKEN", () => profile(async (source) => {
  let guards = 0;
  let transportCalls = 0;
  const started = Math.floor(Date.now() / 1000);
  const result = await readZzzGachaAuthKey(source, async (url, init) => {
    transportCalls++;
    expect(guards).toBe(1);
    expect(url.href).toBe(auth);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({ auth_appid: "webview_gacha", game_biz: "nap_cn", game_uid: Number(uid), region });
    const headers = new Headers(init.headers);
    for (const [name, expected] of Object.entries({ Cookie: cookie, Host: "api-takumi.mihoyo.com", "Content-Type": "application/json",
      Accept: "application/json", "User-Agent": "okhttp/4.9.3", "x-rpc-app_version": "2.118.1", "x-rpc-client_type": "5",
      Referer: "https://app.mihoyo.com", Origin: "https://webstatic.mihoyo.com", "x-rpc-sys_version": "14", "x-rpc-channel": "mihoyo",
      "x-rpc-device_id": "fixture-device", "x-rpc-device_fp": "fixture-fp", "x-rpc-device_name": "Fixture",
      "x-rpc-device_model": "Fixture-Model",
    })) expect(headers.get(name)).toBe(expected);
    const [time, nonce, signature] = headers.get("DS")!.split(",");
    expect(Number(time)).toBeGreaterThanOrEqual(started);
    expect(nonce).toMatch(/^[a-z0-9]{6}$/u);
    expect(signature).toBe(createHash("md5").update(`salt=7a047e46eadd8693f09513e55bdf6bd8&t=${time}&r=${nonce}`).digest("hex"));
    return success({ game_uid: Number(uid), game_biz: "nap_cn", auth_appid: "webview_gacha", region, sign_type: 2, authkey_ver: "1" });
  }, {}, async () => { guards++; });
  expect([guards, transportCalls]).toEqual([2, 1]);
  expect(result).toMatchObject({ uid, region, gameBiz: "nap_cn" });
  expect(result.url.origin + result.url.pathname).toBe(history);
  expect(Object.fromEntries(result.url.searchParams)).toEqual({
    authkey_ver: "1", sign_type: "2", auth_appid: "webview_gacha", init_log_gacha_type: "2001", init_log_gacha_base_type: "2",
    gacha_id: "2c1f5692fdfbb733a08733f9eb69d32aed1d37", timestamp: expect.stringMatching(/^\d+$/u), lang: "zh-cn",
    device_type: "mobile", plat_type: "ios", region, authkey: key, game_biz: "nap_cn", gacha_type: "2001", real_gacha_type: "2",
    page: "1", size: "20", end_id: "0",
  });
  expect(result.url.href).not.toContain(cookie);
  expect(parseZzzGachaLink(result.url.href, source.role)).toEqual({ uid, region, gameBiz: "nap_cn" });
}));

test("海外、错误游戏与 STOKEN 归属或设备字段不一致时不发请求", () => profile(async (source) => {
  const invalid: ProfileRequestContext[] = [
    { ...source, game: "gs" },
    { ...source, role: { ...source.role, uid: "1300000002", region: "prod_gf_jp", gameBiz: "nap_global" } },
    { ...source, role: { ...source.role, region: "prod_gf_jp" } },
    { ...source, account: { ...source.account, stokenCookie: "" } },
    { ...source, account: { ...source.account, stuid: "8081" } },
    { ...source, account: { ...source.account, stoken: "different-profile-token" } },
    { ...source, account: { ...source.account, mid: "different-profile-mid" } },
    { ...source, account: { ...source.account, stokenCookie: `${cookie}\r\nX-Unknown: value` } },
    { ...source, device: { ...source.device, name: "bad\r\nheader" } },
  ];
  let attempts = 0;
  for (const current of invalid) {
    await expect(readZzzGachaAuthKey(current, async () => { attempts++; return success(); })).rejects.toMatchObject({ code: "invalid-input" });
  }
  expect(attempts).toBe(0);
}));

test("只有明确官方档案凭据失效标记可刷新，HTTP、风控和其他错误均不得刷新", () => profile(async (source) => {
  for (const retcode of [-100, 10001, "10101", 10102, 10103]) {
    const error = await readZzzGachaAuthKey(source, async () => Response.json({ retcode })).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "api", retcode: Number(retcode) });
    expect(isZzzGachaAuthExpired(error)).toBe(true);
  }
  for (const [status, retcode] of [[401, -100], [429, 10001], [503, 10102], [200, 1034],
    [200, 10035], [200, 10041], [200, -110], [200, -101], [200, 1016]] as const) {
    let count = 0;
    const error = await readZzzGachaAuthKey(source, async () => {
      count++;
      return Response.json({ retcode, message: key }, { status });
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HoyoRequestError);
    expect(error).toMatchObject({ code: status === 200 ? "api" : "http", status });
    expect(String(error)).not.toContain(key);
    expect(isZzzGachaAuthExpired(error)).toBe(false);
    expect(count).toBe(1);
  }
}));

test("拒绝畸形授权响应、区服或角色回显不符，换绑和取消时不交付链接", () => profile(async (source) => {
  for (const makeResponse of [() => success({ game_uid: "600000003" }), () => success({ region: "prod_gf_cn" }),
    () => success({ game_biz: "nap_global" }), () => success({ auth_appid: "im_ccs" }), () => success({ authkey_ver: 2 }),
    () => success({ sign_type: 1 }), () => success({ authkey: "\nuser-token" }), () => success({ authkey: "x".repeat(4097) }),
    () => Response.json({ retcode: "no-code", data: {} }), () => new Response("x".repeat(32 * 1024 + 1)),
  ]) {
    await expect(readZzzGachaAuthKey(source, async () => makeResponse())).rejects.toMatchObject({ code: "response" });
  }
  let guards = 0;
  const error = await readZzzGachaAuthKey(source, async () => Response.json({ retcode: -100 }), {}, async () => {
    if (++guards === 2) throw new HoyoRequestError("profile-changed", "档案已切换。");
  }).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "profile-changed" });
  expect(isZzzGachaAuthExpired(error)).toBe(false);
  expect(guards).toBe(2);
  const cancel = new AbortController();
  await expect(readZzzGachaAuthKey(source, async () => { cancel.abort(); return success(); }, { signal: cancel.signal }))
    .rejects.toMatchObject({ code: "transport" });
  await expect(readZzzGachaAuthKey(source, async () => { throw new Error(key); })).rejects.toThrow(/^绝区零抽卡链接授权请求未完成。$/u);
}));

test("绝区零签发抽卡链接只在续期后原角色仍被选中时重试", () => profile(async (source, profiles) => {
  const roles = ["100000003"];
  const authorizationReads: number[] = [];
  const client = createHoyoClient(async (url, init) => {
    if (url.pathname === "/binding/api/getUserGameRolesByCookie") {
      return Response.json({ retcode: 0, data: { list: roles.map(game_uid => ({
        game_uid, region: game_uid === uid ? region : "prod_gf_cn", game_biz: "nap_cn",
      })) } });
    }
    expect(url.href).toBe(auth);
    authorizationReads.push(JSON.parse(String(init.body)).game_uid);
    return authorizationReads.length === 1 ? Response.json({ retcode: -100 }) : success();
  }, { profiles, syncRoles: true, exchange: async () => ({
    ltoken: "new-token", cookie: "account_id_v2=8080;account_mid_v2=test-mid;cookie_token_v2=renewed",
  }) });
  await expect(client.fetchZzzGachaAuthKey(source)).rejects.toMatchObject({ code: "profile-changed" });
  expect(authorizationReads).toEqual([Number(uid)]);
  const updated = await profiles.requestSelectedContext("42", 2, "zzz");
  expect(updated.role.uid).toBe(roles[0]!);
  expect(updated.account.cookie).toContain("cookie_token_v2=renewed");
}));

test("续期目录保留绝区零原选角时可重试一次，并采用续期后的档案", () => profile(async (source, profiles) => {
  const authorizationReads: number[] = [];
  const client = createHoyoClient(async (url, init) => {
    if (url.pathname === "/binding/api/getUserGameRolesByCookie") {
      return Response.json({ retcode: 0, data: { list: [{ game_uid: uid, region, game_biz: "nap_cn" }] } });
    }
    expect(url.href).toBe(auth);
    authorizationReads.push(JSON.parse(String(init.body)).game_uid);
    return authorizationReads.length === 1 ? Response.json({ retcode: -100 }) : success();
  }, { profiles, syncRoles: true, exchange: async () => ({
    ltoken: "new-token", cookie: "account_id_v2=8080;account_mid_v2=test-mid;cookie_token_v2=renewed",
  }) });
  expect(await client.fetchZzzGachaAuthKey(source)).toMatchObject({
    uid, refreshedCookie: true, revision: (await profiles.requestSelectedContext("42", 2, "zzz")).revision,
  });
  expect(authorizationReads).toEqual([Number(uid), Number(uid)]);
}));
