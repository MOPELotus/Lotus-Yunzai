import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, type ProfileRequestContext } from "../packages/account/index.ts";
import { createHoyoClient, type GenshinBackpackProbe } from "../packages/hoyo-client/index.ts";
import { readGenshinBackpack } from "../packages/hoyo-client/genshin-backpack.ts";

const uid = "512345678";
const region = "cn_qd01";
const role = { uid, region, gameBiz: "hk4e_cn", nickname: "", chosen: false };
const cookie = "cookie_token=fixture-old";
const source = {
  qq: "42", profileId: 2, game: "gs", revision: "fixture-revision", account: { cookie },
  device: { id: "fixture-id", fp: "fixture-fp", model: "Fixture", androidVersion: "14" }, role,
} as ProfileRequestContext;
const probe: GenshinBackpackProbe = { items: [{
  avatar_id: 10000015, avatar_level_current: 1, avatar_level_target: 90, element_attr_id: 0,
  skill_list: [{ id: 1531, level_current: 1, level_target: 10 }],
  weapon: { id: 14515, level_current: 1, level_target: 90 },
}] };
const options = { probe };
const endpoint = "https://api-takumi.mihoyo.com/event/e20200928calculate/v3/batch_compute";
const row = { id: 202, name: "摩拉", num: 100, lack_num: 40 };

function answer(data: object = { overall_consume: [row] }) {
  return Response.json({ retcode: 0, data });
}

test("背包请求只使用当前档案的区服、Cookie 和设备，且签名实际发送的 POST JSON", async () => {
  const leakedFields = {
    items: [{ ...probe.items[0]!, uid: "123456789" }],
    uid: "123456789",
    region: "cn_gf01",
  };
  const checks: string[] = [];
  const result = await readGenshinBackpack(source, async (url, init) => {
    checks.push("request");
    expect(url.href).toBe(endpoint);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = String(init.body);
    expect(JSON.parse(body)).toEqual({ items: probe.items, uid, region });
    const headers = new Headers(init.headers);
    expect(headers.get("Cookie")).toBe(cookie);
    expect(headers.get("x-rpc-device_id")).toBe("fixture-id");
    expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
    const [time, nonce, digest] = headers.get("DS")!.split(",");
    expect(digest).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${time}&r=${nonce}&b=${body}&q=`).digest("hex"));
    return answer({ uid, server: region, role: { game_uid: Number(uid), game_biz: "hk4e_cn", region },
      overall_consume: [
        row,
        { id: "17", game_id: 104003, name: "大英雄的经验", num: 5, lack_num: "-3",
          icon: "https://act-webstatic.mihoyo.com/item.png?fixture=secret" },
        { id: 19, name: "精锻用魔矿", num: 7, lack_num: 0, icon: "http://127.0.0.1/icon.png" },
        { id: 20, name: "经验", num: 10, lack_num: 10 },
      ] });
  }, { probe: leakedFields }, async () => { checks.push("profile"); });
  expect(checks).toEqual(["profile", "request", "profile"]);
  expect(result).toEqual({ uid, region, items: [
    { id: "202", name: "摩拉", count: 60, exact: true },
    { id: "17", gameId: "104003", name: "大英雄的经验", count: 8, exact: true, icon: "https://act-webstatic.mihoyo.com/item.png" },
    { id: "19", name: "精锻用魔矿", count: 7, exact: false },
    { id: "20", name: "经验", count: 0, exact: true },
  ] });
});

test("拒绝未绑定设备、海外及错误区服、失效配方和档案变更", async () => {
  let calls = 0;
  const transport = async () => { calls++; return answer(); };
  for (const invalid of [
    { ...source, device: { ...source.device, fp: "" } },
    { ...source, device: { ...source.device, id: "" } },
    { ...source, device: { ...source.device, fp: "illegal\nfixture" } },
    { ...source, role: { ...role, region: "cn_gf01" } },
    { ...source, role: { ...role, region: "os_usa" } },
  ]) {
    await expect(readGenshinBackpack(invalid, transport, options)).rejects.toMatchObject({ code: "invalid-input" });
  }
  for (const items of [
    [],
    new Array(129).fill(probe.items[0]),
    [{ ...probe.items[0]!, avatar_level_target: 101 }],
    [{ ...probe.items[0]!, weapon: { id: 1, level_current: 5, level_target: 4 } }],
  ]) {
    await expect(readGenshinBackpack(source, transport, { probe: { items } })).rejects.toMatchObject({ code: "invalid-input" });
  }
  const stale = new Error("profile changed");
  await expect(readGenshinBackpack(source, transport, options, async () => { throw stale; })).rejects.toBe(stale);
  expect(calls).toBe(0);
  let checks = 0;
  await expect(readGenshinBackpack(source, transport, options, async () => {
    if (++checks === 2) throw stale;
  })).rejects.toBe(stale);
  expect(calls).toBe(1);
});

test("核对响应中可用的角色身份，并拒绝畸形或超界库存数据", async () => {
  for (const data of [
    {}, { overall_consume: null }, { overall_consume: [row], uid: "512345679" },
    { overall_consume: [row], region: "cn_gf01" }, { overall_consume: [row], role: { role_id: "1" } },
    { overall_consume: [row], game_biz: "nap_cn" }, { overall_consume: [row, row] },
    { overall_consume: Array.from({ length: 1025 }, (_, i) => ({ ...row, id: i + 1 })) },
    ...[{ num: null }, { num: false }, { num: 1.5 }, { lack_num: undefined }, { lack_num: 101 },
      { lack_num: -Number.MAX_SAFE_INTEGER }, { id: undefined }, { id: "01" }, { game_id: "not-an-id" }]
      .map((fields) => ({ overall_consume: [{ ...row, ...fields }] })),
  ]) {
    await expect(readGenshinBackpack(source, async () => answer(data), options)).rejects.toMatchObject({ code: "response" });
  }
  expect(await readGenshinBackpack(source, async () => answer({ overall_consume: [] }), options))
    .toEqual({ uid, region, items: [] });
});

test("错误响应和流式体积受限，取消可以中断未完成的读取", async () => {
  let cancelled = 0;
  for (const headers of [new Headers({ "Content-Length": "2097153" }), new Headers()]) {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_100_000));
        controller.enqueue(new Uint8Array(1_100_000));
      },
      cancel() { cancelled++; },
    }), { headers });
    await expect(readGenshinBackpack(source, async () => response, options)).rejects.toMatchObject({ code: "response" });
  }
  const abort = new AbortController();
  const reading = Promise.withResolvers<void>();
  const result = readGenshinBackpack(source, async () => new Response(new ReadableStream<Uint8Array>({
    pull() { reading.resolve(); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 })), { ...options, signal: abort.signal });
  await reading.promise;
  abort.abort();
  await expect(result).rejects.toMatchObject({ code: "transport" });
  expect(cancelled).toBe(3);
});

test("同一档案只在明确过期时续期一次，限额、风控或未知失败不续期", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-backpack-reader-"));
  try {
    await writeFile(join(directory, "42-2.yaml"), `
version: 1
user: { qq: "42" }
profile: { id: 2 }
account:
  ltuid: "8080"
  cookie: "${cookie}"
  stoken: fixture-stoken
  game_roles: { gs: [{ uid: "${uid}", region: ${region}, game_biz: hk4e_cn }] }
  current_uid: { gs: "${uid}" }
device: { bound: true, id: fixture-id, fp: fixture-fp }
`);
    const profiles = createProfileStore(directory);
    const context = await profiles.requestContext("42", 2, "gs");
    let expectedRevision = context.revision;
    let exchangeCount = 0;
    const cookies: Array<string | null> = [];
    let mock = () => answer();
    const client = createHoyoClient(async (url, init) => {
      expect(url.href).toBe(endpoint);
      const headers = new Headers(init.headers);
      cookies.push(headers.get("Cookie"));
      expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
      expect(JSON.parse(String(init.body))).toEqual({ items: probe.items, uid, region });
      return mock();
    }, {
      profiles,
      async exchange(profile) {
        exchangeCount++;
        expect([profile.qq, profile.profileId, profile.revision]).toEqual(["42", 2, expectedRevision]);
        return { ltoken: "fixture-ltoken", cookie: exchangeCount === 1 ? "cookie_token=fixture-new" : "cookie_token=fixture-newer" };
      },
    });
    for (const response of [
      () => Response.json({ retcode: 10101, message: "limit" }),
      () => Response.json({ retcode: 10102, message: "Data is not public for the user" }),
      () => Response.json({ retcode: -100, message: "请先完成验证码" }),
      () => Response.json({ retcode: -100 }, { status: 401, headers: { "x-rpc-aigis": '{"challenge":"fixture"}' } }),
      () => Response.json({ retcode: 1034 }),
      () => new Response(null, { status: 429 }),
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 503 }),
    ]) {
      mock = response;
      await expect(client.fetchGenshinBackpack(context, options)).rejects.toThrow();
    }
    expect(cookies).toEqual(new Array(8).fill(cookie));
    expect(exchangeCount).toBe(0);
    cookies.length = 0;
    mock = () => cookies.length === 1 ? Response.json({ retcode: -100, message: "Please login" }) : answer();
    const result = await client.fetchGenshinBackpack(context, options);
    const latest = await profiles.requestContext("42", 2, "gs");
    expect(cookies).toEqual([cookie, "cookie_token=fixture-new"]);
    expect(exchangeCount).toBe(1);
    expect(result).toMatchObject({ uid, region, refreshedCookie: true, revision: latest.revision });
    expectedRevision = latest.revision;
    cookies.length = 0;
    mock = () => Response.json({ retcode: -100, message: "Please login" });
    await expect(client.fetchGenshinBackpack(latest, options)).rejects.toMatchObject({ reason: "expired" });
    expect(cookies).toEqual(["cookie_token=fixture-new", "cookie_token=fixture-newer"]);
    expect(exchangeCount).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
