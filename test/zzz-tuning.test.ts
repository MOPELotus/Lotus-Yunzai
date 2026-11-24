import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, type ProfileRequestContext } from "../packages/account/index.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";
import { HoyoRequestError } from "../packages/hoyo-client/errors.ts";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import {
  isZzzTuningCookieExpired, readZzzTuning, readZzzTuningInventory, zzzTuningPools, ZzzTuningRateLimitError,
} from "../packages/hoyo-client/zzz-tuning.ts";

const uid = "123456789";
const region = "prod_gf_cn";
const now = new Date("2026-11-19T12:34:56Z");
const options = { intervalMs: 0, now: () => now };
const source = {
  qq: "42", profileId: 2, game: "zzz", revision: "fixture-revision",
  role: { uid, region, gameBiz: "nap_cn", chosen: true, nickname: "测试" },
  account: { cookie: "cookie_token=isolated-fixture", stoken: "unused-login-fixture" },
  device: {},
} as ProfileRequestContext;

const weapon = "GACHA_TYPE_WEAPON_UP";
const bangboo = "GACHA_TYPE_BANGBOO";
const currentVersion = "2.10";
const versions = Array.from({ length: 9 }, (_, index) => `2.${index + 1}`);
const pulls = [
  { item_id: "12001", name: "音擎 A", rarity: "S", item_type: "WEAPON", is_up: "1", count: "14", record_time: "1700000123", sort: "3" },
  { item_id: "12002", name: "音擎 B", rarity: "S", item_type: "WEAPON", is_up: 0, count: "10", record_time: "1690000123", sort: "2" },
];
const empty = { list: [] };
const periods = (version: string, records: readonly unknown[] = []) => ({
  version, gacha_state: "CURRENT", start_ts: "1000", end_ts: "2000",
  cur_records: records, cur_item_list: [], first_up: { item_id: "0" },
});
const band = (type: keyof typeof zzzTuningPools) => ({
  gacha_type: type,
  total_count: type === weapon ? "35" : type === bangboo ? "7" : "0",
  s_count: type === weapon ? "2" : "0",
  next_s_cur_times: type === weapon ? "3" : null,
  avr_up_count: type === weapon ? "12.5" : null,
  has_data_vers: type === weapon ? [currentVersion, ...versions, versions[0]] : [],
});
function index() {
  return {
    uid, region, cur_ver: currentVersion, total_gacha_count: 35, total_s_count: 2,
    type_stats: (Object.keys(zzzTuningPools) as (keyof typeof zzzTuningPools)[]).map(band),
    cur_tickets: [
      { ticket_type: "GACHA_TICKET_TYPE_POLYCHROME", ticket_cnt: "165" },
      { ticket_type: "GACHA_TICKET_TYPE_RECHARGE_MONOCHROME", ticket_cnt: 0 },
      { ticket_type: "GACHA_TICKET_TYPE_ENCRYPTED_MASTER_TAPE", ticket_cnt: 12 },
      { ticket_type: "GACHA_TICKET_TYPE_MASTER_TAPE", ticket_cnt: 14 },
      { ticket_type: "GACHA_TICKET_TYPE_BOOPON", ticket_cnt: 1 },
      { ticket_type: "FUTURE_TICKET_TYPE", ticket_cnt: 9 },
    ],
  };
}

function ok(data: unknown) {
  return Response.json({ retcode: 0, data });
}

function answer(url: URL): Response {
  if (url.pathname.endsWith("/index")) return ok(index());
  const pool = url.searchParams.get("gacha_type");
  if (pool !== "3") return ok(empty);
  if (url.pathname.endsWith("/cur_pool_stat")) return ok({ list: [periods(currentVersion, [pulls[0]])] });
  const batch = url.searchParams.get("vers")!.split(",");
  return ok({ list: batch.map((version, i) => periods(version, i || batch.length < 8 ? [] : pulls)) });
}

test("同一档案的调频请求遇到 HTTP 401 后刷新一次，从总览重读六个频段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-zzz-tuning-profile-"));
  try {
    const file = join(directory, "42-2.yaml");
    await writeFile(file, `
user: { qq: "42" }
profile: { id: 2 }
account:
  cookie: cookie_token=fixture-old
  stoken: test-stoken
  stuid: "42"
  game_roles: { zzz: [{ uid: "${uid}", region: ${region}, game_biz: nap_cn }] }
  current_uid: { zzz: "${uid}" }
`);
    const profiles = createProfileStore(directory);
    const context = await profiles.requestContext("42", 2, "zzz");
    let refreshes = 0;
    const cookies: Array<[string, string | null]> = [];
    const client = createHoyoClient(async (url, init) => {
      const cookie = new Headers(init.headers).get("Cookie");
      cookies.push([url.pathname.split("/").at(-1)!, cookie]);
      if (cookie === "cookie_token=fixture-old" && url.pathname.endsWith("/cur_pool_stat")) {
        return new Response(null, { status: 401 });
      }
      return answer(url);
    }, {
      profiles,
      async exchange(profile) {
        refreshes++;
        expect([profile.qq, profile.profileId, profile.revision]).toEqual(["42", 2, context.revision]);
        return { ltoken: "fixture-token", cookie: "cookie_token=fixture-new" };
      },
    });
    const result = await client.fetchZzzTuning(context, options);
    expect(refreshes).toBe(1);
    expect(cookies.slice(0, 3)).toEqual([
      ["index", "cookie_token=fixture-old"], ["cur_pool_stat", "cookie_token=fixture-old"],
      ["index", "cookie_token=fixture-new"],
    ]);
    expect(cookies.slice(2).every(([, cookie]) => cookie === "cookie_token=fixture-new")).toBe(true);
    const latest = await profiles.requestContext("42", 2, "zzz");
    expect(result).toMatchObject({ uid, revision: latest.revision, refreshedCookie: true, totalDraws: 35 });
    expect(result.pools).toHaveLength(6);
    const inventory = await client.fetchZzzTuningInventory(latest, options);
    expect(inventory).toMatchObject({ uid, refreshedCookie: false, inventory: { monochrome: 0 } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads all six bands with the official Cookie, batches historical versions, and checks current plus historical S records", async () => {
  const seen: [string, string | null, string | null][] = [];
  let guards = 0;
  const result = await readZzzTuning(source, async (url, init) => {
    expect(url.origin).toBe("https://act-api-takumi.mihoyo.com");
    expect(url.pathname.startsWith("/event/nap_gacha_record/api/zzz/")).toBe(true);
    expect(url.searchParams.get("uid")).toBe(uid);
    expect(url.searchParams.get("region")).toBe(region);
    expect(url.searchParams.has("authkey")).toBe(false);
    expect(new Headers(init.headers).get("cookie")).toBe(source.account.cookie);
    expect(new Headers(init.headers).get("origin")).toBe("https://act.mihoyo.com");
    expect(new Headers(init.headers).get("referer")).toBe("https://act.mihoyo.com/zzz/event/gacha-record/index.html");
    expect(init.redirect).toBe("error");
    seen.push([url.pathname.split("/").at(-1)!, url.searchParams.get("gacha_type"), url.searchParams.get("vers")]);
    return answer(url);
  }, options, async () => { guards++; });

  expect(seen).toEqual([
    ["index", null, null],
    ["cur_pool_stat", "3", null],
    ["hist_pool_stat", "3", versions.slice(0, 8).join(",")],
    ["hist_pool_stat", "3", versions[8]!],
    ["cur_pool_stat", "103", null], ["cur_pool_stat", "2", null], ["cur_pool_stat", "102", null],
    ["cur_pool_stat", "1", null], ["cur_pool_stat", "5", null],
  ]);
  expect(guards).toBe(seen.length * 2 + 1);
  expect(result).toMatchObject({ version: 1, profileId: 2, uid, region, currentVersion, totalDraws: 35, totalS: 2, updatedAt: now.toISOString() });
  expect(result.inventory).toEqual({ polychrome: 165, monochrome: 0, encryptedMasterTape: 12, masterTape: 14, boopon: 1 });
  expect(result.pools.map((pool) => pool.type)).toEqual([
    weapon, "GACHA_TYPE_WEAPON_RETURN", "GACHA_TYPE_CHARACTER_UP", "GACHA_TYPE_CHARACTER_RETURN",
    "GACHA_TYPE_PERMANENT", bangboo,
  ]);
  expect(result.pools[0]).toMatchObject({
    type: weapon, totalDraws: 35, totalS: 2, pity: 3, averageUp: 12.5,
    records: [
      { itemId: "12001", isUp: true, count: 14, time: 1700000123, version: currentVersion },
      { itemId: "12002", isUp: false, count: 10, time: 1690000123, version: versions[0] },
    ],
  });
  expect(result.pools[0]!.periods.map(({ version }) => version)).toEqual([currentVersion, ...versions]);
  expect(result.pools.at(-1)).toMatchObject({ type: bangboo, totalDraws: 7, totalS: 0 });
});

test("does not output a snapshot for missing bands, missing history, invalid records, or mismatched totals", async () => {
  const check = (transport: HoyoTransport) => readZzzTuning(source, transport, options);
  await expect(check(async (url) => url.pathname.endsWith("/index")
    ? ok({ ...index(), type_stats: index().type_stats.slice(1) }) : answer(url))).rejects.toThrow("六个频段");
  await expect(check(async (url) => url.pathname.endsWith("/index")
    ? ok({ ...index(), type_stats: [...index().type_stats, band(weapon)] }) : answer(url))).rejects.toThrow("重复频段");
  await expect(check(async (url) => url.pathname.endsWith("/hist_pool_stat") && url.searchParams.get("vers") === versions.at(-1)
    ? ok(empty) : answer(url))).rejects.toThrow("历史期次返回不全");
  await expect(check(async (url) => url.pathname.endsWith("/cur_pool_stat") && url.searchParams.get("gacha_type") === "5"
    ? ok({ list: [periods(currentVersion, [{ ...pulls[0], rarity: "A" }])] }) : answer(url))).rejects.toThrow("邦布频段");
  await expect(check(async (url) => url.pathname.endsWith("/index")
    ? ok({ ...index(), total_gacha_count: 42 }) : answer(url))).rejects.toThrow("总览与分频段");
});

test("keeps real duplicate pulls when required by the official S total", async () => {
  const result = await readZzzTuning(source, async (url) => {
    if (url.pathname.endsWith("/cur_pool_stat") && url.searchParams.get("gacha_type") === "3") {
      return ok({ list: [periods(currentVersion, [pulls[0], pulls[0]])] });
    }
    if (url.pathname.endsWith("/hist_pool_stat")) {
      return ok({ list: url.searchParams.get("vers")!.split(",").map((version) => periods(version, [pulls[0]])) });
    }
    return answer(url);
  }, options);
  const pool = result.pools[0]!;
  expect(pool.records).toHaveLength(2);
  expect(pool.records.map(({ itemId, version }) => [itemId, version])).toEqual([
    ["12001", currentVersion], ["12001", currentVersion],
  ]);
});

test("区分认证、业务限频及风控，且不提前重试超出预算的 HTTP 429", async () => {
  async function fail(response: Response) {
    let calls = 0;
    let failure: unknown;
    try {
      await readZzzTuning(source, async () => { calls++; return response; }, options);
    } catch (error) {
      failure = error;
    }
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(HoyoRequestError);
    return failure as HoyoRequestError;
  }

  expect(isZzzTuningCookieExpired(await fail(new Response(null, { status: 401 })))).toBe(true);
  expect(isZzzTuningCookieExpired(await fail(Response.json({ retcode: "-100" })))).toBe(true);
  expect(isZzzTuningCookieExpired(await fail(Response.json({ retcode: 12, message: "Cookie 已过期" })))).toBe(true);
  expect(isZzzTuningCookieExpired(await fail(Response.json({ retcode: 12, message: "invalid parameters" })))).toBe(false);
  expect(isZzzTuningCookieExpired(await fail(Response.json({ retcode: 10041, message: "请登录" })))).toBe(false);
  expect(isZzzTuningCookieExpired(await fail(new Response(null, { status: 403 })))).toBe(false);
  const limit = await fail(new Response(null, { status: 429, headers: { "Retry-After": "65" } }));
  expect(limit).toBeInstanceOf(ZzzTuningRateLimitError);
  expect(limit).toMatchObject({ code: "http", status: 429, retryAfterMs: 65_000 });
  const apiLimit = await fail(Response.json({ retcode: 12, message: "visit too frequently" }));
  expect(apiLimit).toBeInstanceOf(ZzzTuningRateLimitError);
  expect(apiLimit).toMatchObject({ code: "api", retcode: 12 });
  expect(isZzzTuningCookieExpired(limit)).toBe(false);
  expect(isZzzTuningCookieExpired(apiLimit)).toBe(false);
});

test("guards credentials and revision before and after transport, including inventory-only calls", async () => {
  const changed = new HoyoRequestError("profile-changed", "档案已变化。");
  let requests = 0;
  let invalid = false;
  await expect(readZzzTuning(source, async (url) => {
    requests++;
    invalid = true;
    return answer(url);
  }, options, async () => {
    if (invalid) throw changed;
  })).rejects.toBe(changed);
  expect(requests).toBe(1);

  const neverSend: HoyoTransport = async () => { throw new Error("unexpected transmission"); };
  await expect(readZzzTuning({ ...source, role: { ...source.role, region: "prod_gf_us" } }, neverSend, options))
    .rejects.toMatchObject({ code: "invalid-input" });
  await expect(readZzzTuning({ ...source, account: { ...source.account, cookie: "broken" } }, neverSend, options))
    .rejects.toMatchObject({ code: "invalid-input" });
  const controller = new AbortController();
  controller.abort();
  await expect(readZzzTuning(source, neverSend, { ...options, signal: controller.signal })).rejects.toThrow("请求已取消");
  await expect(readZzzTuningInventory(source, async () => ok({ ...index(), uid: "123456780" }), options))
    .rejects.toThrow("UID 或分区不一致");

  const inventory = await readZzzTuningInventory(source, async (url) => {
    expect(url.pathname).toEndWith("/index");
    return ok({ cur_tickets: [{ ticket_type: "GACHA_TICKET_TYPE_BOOPON", ticket_cnt: 0 }] });
  }, options);
  expect(inventory).toEqual({ uid, fetchedAt: now.toISOString(), inventory: { boopon: 0 } });
});

test("只按服务器允许的 Retry-After 等待同一读取，受退避与总预算约束", async () => {
  let clock = now.getTime();
  const waits: number[] = [];
  const requests: string[] = [];
  const clockOptions = {
    ...options, now: () => new Date(clock),
    async sleep(delay: number) { waits.push(delay); clock += delay; },
  };
  function tooSoon(retryAfter?: string) {
    return new Response(null, { status: 429, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } });
  }
  const latest = await readZzzTuningInventory(source, async (url, init) => {
    expect(new Headers(init.headers).get("Cookie")).toBe(source.account.cookie);
    requests.push(url.href);
    if (requests.length === 1) return tooSoon("7");
    if (requests.length === 2) return tooSoon(new Date(clock + 32_000).toUTCString());
    return ok({ cur_tickets: [{ ticket_type: "GACHA_TICKET_TYPE_BOOPON", ticket_cnt: 0 }] });
  }, clockOptions);
  expect(waits).toEqual([15_000, 32_000]);
  expect(requests).toHaveLength(3);
  expect(new Set(requests).size).toBe(1);
  expect(latest).toMatchObject({ inventory: { boopon: 0 }, fetchedAt: new Date(now.getTime() + 47_000).toISOString() });

  for (const retryAfter of [undefined, "07x", "1.5", "100", new Date(now.getTime() + 5_000).toISOString()]) {
    let attempts = 0;
    waits.length = 0;
    await expect(readZzzTuningInventory(source, async () => { attempts++; return tooSoon(retryAfter); }, clockOptions))
      .rejects.toBeInstanceOf(ZzzTuningRateLimitError);
    expect(waits).toEqual([]);
    expect(attempts).toBe(1);
  }

  let attempts = 0;
  await expect(readZzzTuningInventory(source, async () => {
    attempts++;
    return tooSoon(attempts === 1 ? "36" : "2");
  }, clockOptions)).rejects.toBeInstanceOf(ZzzTuningRateLimitError);
  expect(attempts).toBe(2);
  expect(waits).toEqual([36_000]);
});

test("等待期间档案变化或取消会拦截同一 URL 的第二次读取", async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const changed = new HoyoRequestError("profile-changed", "档案已变化。");
    let calls = 0;
    let stale = false;
    await expect(readZzzTuningInventory(source, async () => {
      calls++;
      return new Response(null, { status: 429, headers: { "Retry-After": "1" } });
    }, {
      ...options, signal: controller.signal,
      async sleep(milliseconds, signal) {
        expect(milliseconds).toBe(15_000);
        expect(signal).toBe(controller.signal);
        if (abort) controller.abort();
        else stale = true;
      },
    }, async () => { if (stale) throw changed; }))
      .rejects.toMatchObject({ code: abort ? "transport" : "profile-changed" });
    expect(calls).toBe(1);
  }
});

test("空缺的可选库存数量保留未知，零数量不丢，也不阻断六频段调频", async () => {
  const cur_tickets = [
    { ticket_type: "GACHA_TICKET_TYPE_RECHARGE_MONOCHROME", ticket_cnt: "0" },
    { ticket_type: "GACHA_TICKET_TYPE_POLYCHROME", ticket_cnt: "" },
    { ticket_type: "GACHA_TICKET_TYPE_ENCRYPTED_MASTER_TAPE", ticket_cnt: null },
    { ticket_type: "GACHA_TICKET_TYPE_MASTER_TAPE" },
    { ticket_type: "GACHA_TICKET_TYPE_BOOPON", ticket_cnt: 18 },
  ];
  const inventory = { monochrome: 0, boopon: 18 };
  const snapshot = await readZzzTuning(source, async url => url.pathname.endsWith("/index")
    ? ok({ ...index(), cur_tickets }) : answer(url), options);
  expect(snapshot.pools).toHaveLength(6);
  expect(snapshot.inventory).toEqual(inventory);
  expect(await readZzzTuningInventory(source, async () => ok({ cur_tickets }), options)).toMatchObject({ inventory });
  await expect(readZzzTuningInventory(source, async () => ok({ cur_tickets: [
    ...cur_tickets, { ticket_type: "GACHA_TICKET_TYPE_BOOPON", ticket_cnt: 4 },
  ] }), options)).rejects.toThrow("库存数值无效");
});
