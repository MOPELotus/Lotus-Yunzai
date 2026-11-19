import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, type ProfileRequestContext } from "../packages/account/index.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";
import { HoyoRequestError } from "../packages/hoyo-client/errors.ts";
import { GenshinAuthKeyRequestError, genshinGachaPools } from "../packages/hoyo-client/genshin-gacha.ts";
import { readGenshinMiniapp } from "../packages/hoyo-client/genshin-miniapp.ts";

const uid = "512345678";
const region = "cn_qd01";
const authEndpoint = "https://api-takumi.mihoyo.com/binding/api/genAuthKey";
const helperEndpoint = "https://www.lelaer.com/outputGacha.php";
const authkey = "fixture-bearer+/%key?=";
const cookie = "stoken=v2_fixture;stuid=8080;mid=fixture-mid";

async function fixture(run: (source: ProfileRequestContext) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-genshin-miniapp-"));
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
    gs: [{ game_uid: "${uid}", game_biz: hk4e_cn, region: ${region} }]
  current_uid: { gs: "${uid}" }
`);
    await run(await createProfileStore(directory).requestContext("42", 2, "gs"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function row<Id extends string | number = string, Pool extends string | number = "301">(id?: Id, gachaType?: Pool) {
  return { id: id ?? "1735853810000001922", gacha_type: gachaType ?? ("301" as const),
    name: "夹具角色", item_type: "角色", rank_type: "5", time: "2024-02-29 03:04:05" };
}

function official() {
  return Response.json({ retcode: 0, data: { authkey, region, game_uid: uid, game_biz: "hk4e_cn" } });
}

function transport(body: () => Response): HoyoTransport {
  return async (url) => {
    if (url.href === authEndpoint) return official();
    expect(url.href).toBe(helperEndpoint);
    return body();
  };
}

test("小助手只向固定站点发送旧导出表单，保持 400 记录与精确编号", () => fixture(async (source) => {
  const first = "1735853810000001922";
  const second = "1735853810000001921";
  const calls: string[] = [];
  const result = await readGenshinMiniapp(source, async (url, init) => {
    calls.push(url.href);
    const headers = new Headers(init.headers);
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    if (url.href === authEndpoint) {
      expect(headers.get("Cookie")).toBe(cookie);
      expect(JSON.parse(String(init.body))).toMatchObject({ game_uid: Number(uid), region });
      return official();
    }
    expect(url.href).toBe(helperEndpoint);
    expect(init.method).toBe("POST");
    expect(init.referrerPolicy).toBe("no-referrer");
    for (const name of ["Cookie", "Referer", "Origin", "Authorization", "DS", "x-rpc-device_id"]) {
      expect(headers.has(name)).toBe(false);
    }
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(init.body));
    expect([...form.keys()]).toEqual(["uid", "gachaurl", "lang"]);
    expect(form.get("uid")).toBe(uid);
    expect(form.get("lang")).toBe("zh-Hans");
    expect(String(init.body)).not.toContain("stoken");
    const gachaUrl = new URL(form.get("gachaurl")!);
    expect(gachaUrl.origin).toBe("https://public-operation-hk4e.mihoyo.com");
    expect(gachaUrl.pathname).toBe("/gacha_info/api/getGachaLog");
    expect(Object.fromEntries(gachaUrl.searchParams)).toMatchObject({ authkey, game_biz: "hk4e_cn", region, size: "5",
      gacha_type: "301", page: "1", end_id: "0", authkey_ver: "1", auth_appid: "webview_gacha", sign_type: "2" });
    return Response.json({ info: { uid: Number(uid) }, uid, list: [
      { ...row(first, "301"), lang: "zh-cn", item_id: "10000046", is_up: true, gachaurl: gachaUrl.href },
      { ...row(`00${second}`, 400), uid, uigf_gacha_type: "301" },
      { ...row(17, "302"), item_type: "武器", rank_type: 4, name: "夹具武器" },
      { ...row("8", "500"), count: "1" },
    ] });
  });
  expect(calls).toEqual([authEndpoint, helperEndpoint]);
  expect(result).toEqual({ uid, region, pools: [
    { ...genshinGachaPools[0], records: [
      { ...row(first), uid, uigf_gacha_type: "301", lang: "zh-cn", item_id: "10000046", is_up: true },
      { ...row(second, "400"), uid, uigf_gacha_type: "301" },
    ] },
    { ...genshinGachaPools[1], records: [{ ...row("17", "302"), uid, uigf_gacha_type: "302", item_type: "武器",
      name: "夹具武器", rank_type: "4" }] },
    { ...genshinGachaPools[2], records: [{ ...row("8", "500"), uid, uigf_gacha_type: "500", count: "1" }] },
    { ...genshinGachaPools[3], records: [] },
  ] });
  expect(JSON.stringify(result)).not.toContain(authkey);
}));

test("小助手导出须归属当前 UID，校验每项和完整响应后才返回四池", () => fixture(async (source) => {
  const proper = { ...row(), uid };
  for (const malformed of [
    { info: { uid }, uid: "123456789", list: [proper] },
    { info: { uid }, list: [{ ...proper, uid: "123456789" }] },
    { list: [row()] },
    { info: { uid }, list: [row(Number("1735853810000001922"))] },
    { info: { uid }, list: [row("0")] },
    { info: { uid }, list: [row(19, "100")] },
    { info: { uid }, list: [{ ...row(20, "400"), uigf_gacha_type: "302" }] },
    { info: { uid }, list: [{ ...row(), time: "2025-02-29 03:04:05" }] },
    { info: { uid }, list: [{ ...row(), name: authkey }] },
    { info: { uid }, list: [{ ...row(), name: encodeURIComponent(authkey) }] },
    { info: { uid }, retcode: -100, list: [] },
    { info: { uid }, list: { 301: [proper] } },
  ]) {
    await expect(readGenshinMiniapp(source, transport(() => Response.json(malformed)))).rejects.toMatchObject({ code: "response" });
  }
  for (const valid of [{ list: [] }, { list: [proper] }]) {
    const snapshot = await readGenshinMiniapp(source, transport(() => Response.json(valid)));
    expect(snapshot.pools.map(({ type, records }) => [type, records.length]))
      .toEqual([[301, valid.list.length], [302, 0], [500, 0], [200, 0]]);
  }
}));

test("第三方跳转、异常、超限和档案变化都不泄漏凭据", () => fixture(async (source) => {
  await expect(readGenshinMiniapp(source, transport(() => new Response(authkey, { status: 302,
    headers: { Location: "https://example.invalid/" },
  })))).rejects.toMatchObject({ code: "http", status: 302, message: "提瓦特小助手导出请求失败。" });
  await expect(readGenshinMiniapp(source, transport(() => new Response(authkey))))
    .rejects.toMatchObject({ code: "response", message: "提瓦特小助手未返回有效的 JSON 导出文件。" });
  await expect(readGenshinMiniapp(source, transport(() => new Response("{}", { headers: { "Content-Length": "40000000" } }))))
    .rejects.toMatchObject({ code: "response", message: "提瓦特小助手的导出文件过大。" });
  const oversized = new Uint8Array(1024 * 1024);
  await expect(readGenshinMiniapp(source, transport(() => new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < 33; index++) controller.enqueue(oversized);
      controller.close();
    },
  }))))).rejects.toThrow("导出文件过大");

  let calls = 0;
  await expect(readGenshinMiniapp(source, async () => {
    calls++;
    return Response.json({ retcode: -100, message: authkey });
  })).rejects.toBeInstanceOf(GenshinAuthKeyRequestError);
  expect(calls).toBe(1);
  let sent = false;
  await expect(readGenshinMiniapp(source, transport(() => {
    sent = true;
    return Response.json({ list: [] });
  }), {}, async () => {
    if (sent) throw new HoyoRequestError("profile-changed", "档案已变更。");
  })).rejects.toMatchObject({ code: "profile-changed" });
  expect(sent).toBe(true);
}));
