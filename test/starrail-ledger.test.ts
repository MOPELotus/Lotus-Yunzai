import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, type ProfileRequestContext } from "@lotus-yunzai/account";
import { createHoyoClient } from "@lotus-yunzai/hoyo-client";

const uid = "100000732", qd = "500000732";
const ticket = "fixture/+ticket%a=";
const source = {
  qq: "42", profileId: 2, game: "sr", revision: "fixture",
  role: { uid, region: "prod_gf_cn", gameBiz: "hkrpg_cn" },
  device: { id: "fixture-device", fp: "fixture-fp" },
  account: { stuid: "42", ltuid: "42", stoken: "fixture-token", stokenCookie: "", mid: "", cookie: "cookie_token=fixture-game; account_id=42" },
} as ProfileRequestContext;
const response = (data: unknown, retcode = 0) => Response.json({ retcode, data });
const row = { time: "2000-01-02 03:04:05", action: "任务奖励", add_num: "2", cookie: "private-sentinel", price: 12345 };

test("星铁流水以同档 SToken 获取 csc 短票，一页十项，第二步不携带 Cookie", async () => {
  const requested: (string | undefined)[] = [];
  const client = createHoyoClient(async (url, init) => {
    expect(url.origin).toBe("https://api-takumi.mihoyo.com");
    expect([init.redirect, init.credentials]).toEqual(["error", "omit"]);
    const headers = new Headers(init.headers);
    if (init.method === "POST") {
      expect(url.pathname).toBe("/binding/api/genAuthKey");
      expect(url.search).toBe("");
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ auth_appid: "csc", game_biz: "hkrpg_cn", game_uid: Number(uid), region: "prod_gf_cn" });
      expect(headers.get("Cookie")).toBe("stuid=42;stoken=fixture-token;mid=;");
      expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
      expect(headers.get("x-rpc-client_type")).toBe("2");
      const [time, nonce, signature] = headers.get("DS")!.split(",");
      expect(signature).toBe(createHash("md5").update(`salt=7a047e46eadd8693f09513e55bdf6bd8&t=${time}&r=${nonce}`).digest("hex"));
      return response({ authkey: ticket, auth_appid: "csc", game_uid: uid, region: "prod_gf_cn", authkey_ver: 1 });
    }
    expect(headers.get("Cookie")).toBeNull();
    expect(url.searchParams.get("authkey")).toBe(ticket);
    expect(url.searchParams.get("auth_appid")).toBe("csc");
    expect(url.searchParams.get("bbs_game_role_required")).toBe("hkrpg_cn");
    expect(url.searchParams.get("page_size")).toBe("10");
    expect(url.searchParams.get("page")).toBe("3");
    requested.push(url.pathname.split("/").at(-2));
    return response({ page: 3, uid, list: [{ ...row, add_num: 0 }, { ...row, add_num: -1 }, { ...row, add_num: 1 }, row, row] });
  });
  const expected = { time: row.time, reason: row.action, count: 2 };
  expect((await client.fetchStarRailLedger(source, { kind: "dreams", page: 3 })).rows)
    .toEqual([{ ...expected, count: 1 }, expected, expected]);
  expect((await client.fetchStarRailLedger(source, { kind: "power", page: 3 })).rows).toEqual([expected, expected]);
  await client.fetchStarRailLedger(source, { kind: "stellar", page: 3 });
  await client.fetchStarRailLedger(source, { kind: "relic", page: 3 });
  expect(requested).toEqual(["Dreams", "Power", "Stellar", "Relic"]);
});

test("流水显式核对国服区服和凭据身份，错归属或失效中止相应阶段", async () => {
  let count = 0, post = response({ authkey: ticket }), get = response({ list: [] });
  const client = createHoyoClient(async (url, options) => {
    count++;
    if (options.method === "POST") {
      expect(JSON.parse(String(options.body))).toMatchObject({ region: "prod_qd_cn", game_uid: Number(qd) });
      expect(new Headers(options.headers).get("Cookie")).toBe("stuid=42;stoken=v2_fixture;mid=fixture-mid;");
      return post.clone();
    }
    expect(url.searchParams.get("page")).toBe("2");
    return get.clone();
  });
  const channel = { ...source, role: { ...source.role, uid: qd, region: "prod_qd_cn" },
    account: { ...source.account, stoken: "v2_fixture", mid: "fixture-mid",
      stokenCookie: "stuid=42;stoken=v2_fixture;mid=fixture-mid;ltoken=ignore-this;" } };
  const request = { kind: "dreams", page: 2 } as const;
  for (const invalid of [
    { ...channel, role: { ...channel.role, region: "" } },
    { ...channel, role: { ...channel.role, region: "prod_official_asia", gameBiz: "hkrpg_global" } },
    { ...channel, account: { ...channel.account, cookie: "account_id=43;" } },
    { ...channel, account: { ...channel.account, mid: "different" } },
  ]) await expect(client.fetchStarRailLedger(invalid, request)).rejects.toMatchObject({ code: "invalid-input" });
  await expect(client.fetchStarRailLedger(channel, { ...request, page: 0 })).rejects.toMatchObject({ code: "invalid-input" });
  expect(count).toBe(0);
  expect((await client.fetchStarRailLedger(channel, request)).rows).toEqual([]);
  post = response({ authkey: ticket, game_uid: uid });
  await expect(client.fetchStarRailLedger(channel, request)).rejects.toMatchObject({ code: "response" });
  expect(count).toBe(3);
  post = response({ authkey: ticket }, -100);
  await expect(client.fetchStarRailLedger(channel, request)).rejects.toThrow("档案登录已失效");
  expect(count).toBe(4);
  post = response({ authkey: ticket });
  get = response(null, -101);
  await expect(client.fetchStarRailLedger(channel, request)).rejects.toThrow("临时授权已失效");
  expect(count).toBe(6);
  for (const malformed of [{ page: 3, list: [] }, { list: Array(11).fill(row) }, { list: [{ ...row, uid }] }]) {
    get = response(malformed);
    await expect(client.fetchStarRailLedger(channel, request)).rejects.toMatchObject({ code: "response" });
  }
  get = new Response(null, { headers: { "x-rpc-aigis": '{"session":"synthetic"}' } });
  await expect(client.fetchStarRailLedger(channel, request)).rejects.toThrow("要求验证");
});

test("换票期间换绑立即终止，登录失效不触发无关 Cookie 续期或任何账目写入", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-starrail-ledger-"));
  const profiles = createProfileStore(directory);
  const path = join(directory, "42-2.yaml");
  const saved = `version: 1
user: { qq: "42" }
profile: { id: 2 }
account:
  cookie: "cookie_token=fixture-game; account_id=42"
  stoken: fixture-token
  stuid: "42"
  game_roles: { sr: [{ uid: "${uid}", region: prod_gf_cn, game_biz: hkrpg_cn }] }
  current_uid: { sr: "${uid}" }
`;
  try {
    await writeFile(path, saved);
    let change = false, posts = 0, exchanges = 0;
    const client = createHoyoClient(async (url) => {
      expect(url.pathname).toBe("/binding/api/genAuthKey");
      posts++;
      if (change) {
        await writeFile(path, saved.replaceAll(uid, "100000733"));
        return response({ authkey: ticket });
      }
      return response(null, -100);
    }, { profiles, async exchange() { exchanges++; throw new Error("不应续期"); } });
    await expect(client.fetchStarRailLedger(await profiles.requestContext("42", 2, "sr"), { kind: "dreams", page: 1 }))
      .rejects.toThrow("档案登录已失效");
    expect(await readFile(path, "utf8")).toBe(saved);
    change = true;
    await expect(client.fetchStarRailLedger(await profiles.requestContext("42", 2, "sr"), { kind: "dreams", page: 1 }))
      .rejects.toMatchObject({ code: "profile-changed" });
    expect([posts, exchanges]).toEqual([2, 0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
