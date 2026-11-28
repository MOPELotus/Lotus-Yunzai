import { expect, test } from "bun:test";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";
import { HoyoRequestError } from "../packages/hoyo-client/errors.ts";
import { isZzzGachaLinkMessage, parseZzzGachaLink, readZzzGachaLink, resolveZzzGachaLinkRole,
  ZzzGachaLinkError } from "../packages/hoyo-client/zzz-gacha-link.ts";

const cn = "https://public-operation-common.mihoyo.com";
const os = "https://public-operation-common-sg.hoyoverse.com";
const path = "/common/gacha_record/api/getGachaLog";
const token = "fixture+auth/key=only";
const role = { uid: "1300000002", region: "prod_gf_jp", gameBiz: "nap_global" } as const;
const options = { intervalMs: 0, now: () => 1_725_000_000_000 };
const timestamp = "2025-09-03 18:00:00";
const bands = [["3001", "3", "音擎频段"], ["13001", "103", "音擎回响"], ["2001", "2", "独家频段"],
  ["12001", "102", "独家重映"], ["1001", "1", "常驻频段"], ["5001", "5", "邦布频段"]] as const;

function url(origin = os, region: string = role.region, gameBiz: string = role.gameBiz) {
  const endpoint = new URL(path, origin);
  endpoint.search = new URLSearchParams({ authkey: token, region, game_biz: gameBiz }).toString();
  return endpoint.href;
}

function page(list: unknown[], fields: object = {}, region: string = role.region, offset = 8) {
  return Response.json({ retcode: 0, data: { region, region_time_zone: offset, size: "20", list, ...fields } });
}

function row(id: string, type: string, fields: object = {}) {
  return { uid: role.uid, id, gacha_type: type, gacha_id: "751403", item_id: "14101", count: "1", rank_type: "4",
    name: "深海访客", item_type: "音擎", lang: "zh-cn", time: timestamp, ...fields };
}

test("解析仅接收已选档案一致的官方链接，认证信息不出现在句柄", async () => {
  const parsed = parseZzzGachaLink(` ${url()} `, role);
  expect(parsed).toEqual(role);
  expect(resolveZzzGachaLinkRole({ uid: role.uid })).toEqual(role);
  expect(isZzzGachaLinkMessage(url())).toBe(true);
  expect(isZzzGachaLinkMessage(`http://untrusted.invalid${path}?authkey=invalid&game_biz=nap_global`)).toBe(true);
  expect(isZzzGachaLinkMessage(`https://public-operation-hkrpg.mihoyo.com${path}?authkey=fixture&game_biz=hkrpg_cn`)).toBe(false);
  expect(isZzzGachaLinkMessage(`https://untrusted.invalid${path}-other?authkey=invalid`)).toBe(false);
  expect(isZzzGachaLinkMessage(`https://untrusted.invalid/?url=${path}`)).toBe(false);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(JSON.stringify(parsed)).not.toContain("fixture");
  expect(parseZzzGachaLink(url(cn, "prod_qd_cn", "nap_cn"), { uid: "600000002", region: "prod_qd_cn" }))
    .toEqual({ uid: "600000002", region: "prod_qd_cn", gameBiz: "nap_cn" });
  for (const input of [
    url().replace("https:", "http:"), url().replace(".com", ".com.example.invalid"),
    url().replace("/common/", "/discard/../common/"), url().replace(os, `${os}:8443`),
    url().replace(os, `${os.replace("https://", "https://user@")} `), url().replace(path, `${path}/`),
    url().replace(os, cn), `${url()}#hidden`, `${url()}&authkey=extra`, `${url()}&region=${role.region}`,
    `${url()}&game_biz=nap_cn`, `${url()}&game_uid=1300000003`, `${url()}&auth_appid=im_ccs`, `${url()}&sign_type=1`,
    url(os, "prod_gf_eu"), url(os, role.region, "nap_cn"), url().replace("%2B", "+"), "authkey=fixture",
  ]) {
    expect(() => parseZzzGachaLink(input, role)).toThrow(HoyoRequestError);
  }
  expect(() => parseZzzGachaLink(url(), { uid: "1900000002", region: role.region })).toThrow(/可核验/u);
  expect(() => parseZzzGachaLink(url(), { ...role, region: "prod_gf_sg" })).toThrow(/可核验/u);
  const never = async () => { throw new Error("unexpected transport"); };
  await expect(readZzzGachaLink({ ...parsed }, never, options)).rejects.toMatchObject({ code: "invalid-input" });
  await expect(readZzzGachaLink(resolveZzzGachaLinkRole(role), never, options)).rejects.toMatchObject({ code: "invalid-input" });
});

test("固定重建所有国服和海外六频段请求，以精确游标追到空页，保留真实重映和回响", async () => {
  const link = parseZzzGachaLink(`${url()}&forward=https://untrusted.invalid&size=99&end_id=123&gacha_type=2000`, role);
  const calls: string[][] = [];
  const newest = "9223372036854775807";
  const previous = "9223372036854775806";
  const older = "9223372036854775805";
  let guarded = 0;
  const transport: HoyoTransport = async (endpoint, init) => {
    expect(endpoint.origin).toBe(os);
    expect(endpoint.pathname).toBe(path);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    for (const name of ["Authorization", "Cookie", "Referer"]) expect(headers.has(name)).toBe(false);
    const query = endpoint.searchParams;
    const type = query.get("gacha_type")!;
    const band = bands.find(([, base]) => base === type)!;
    expect(Object.fromEntries(query)).toEqual({ authkey_ver: "1", sign_type: "2", auth_appid: "webview_gacha",
      init_log_gacha_type: band[0], init_log_gacha_base_type: band[1], gacha_id: "2c1f5692fdfbb733a08733f9eb69d32aed1d37",
      timestamp: "1725000000", lang: "zh-cn", device_type: "mobile", plat_type: "ios", region: role.region, authkey: token,
      game_biz: "nap_global", gacha_type: type, real_gacha_type: band[1], page: query.get("page")!, size: "20",
      end_id: query.get("end_id")!,
    });
    const currentPage = query.get("page")!;
    const endId = query.get("end_id")!;
    calls.push([type, currentPage, endId]);
    if (type === "103" && currentPage === "1") return page([
      row(newest, "13001"), row(previous, "3", { real_gacha_type: "103" }),
    ]);
    if (type === "103" && currentPage === "2") return page([row(older, "103")]);
    if (type === "102" && currentPage === "1") return page([row("9223372036854775701", "102")]);
    return page([]);
  };
  const result = await readZzzGachaLink(link, transport, options, async () => { guarded++; });
  expect(calls).toEqual([
    ["3", "1", "0"], ["103", "1", "0"], ["103", "2", previous], ["103", "3", older],
    ["2", "1", "0"], ["102", "1", "0"], ["102", "2", "9223372036854775701"],
    ["1", "1", "0"], ["5", "1", "0"],
  ]);
  expect(guarded).toBe(calls.length * 2 + 1);
  expect(result).toMatchObject({ ...role, timezone: 8 });
  expect(result.pools.map(({ name, gachaType, records }) => [name, gachaType, records.length]))
    .toEqual(bands.map(([raw, base, name]) => [name, base, raw === "13001" ? 3 : raw === "12001" ? 1 : 0]));
  expect(result.pools[1]?.records.map(({ id }) => id)).toEqual([newest, previous, older]);
  expect(result.pools[1]?.records[0]).toEqual({ id: newest, itemId: "14101", gachaId: "751403", count: 1, time: timestamp, name: "深海访客",
    lang: "zh-cn", itemType: "音擎", rank: "4" });
  expect(JSON.stringify(result)).not.toContain("fixture");

  const cnRole = { uid: "100000002", region: "prod_gf_cn", gameBiz: "nap_cn" };
  const cnLink = parseZzzGachaLink(url(cn, cnRole.region, cnRole.gameBiz), cnRole);
  let domesticRequests = 0;
  const empty = await readZzzGachaLink(cnLink, async (endpoint) => {
    expect(endpoint.origin).toBe(cn);
    expect(endpoint.searchParams.get("game_biz")).toBe("nap_cn");
    domesticRequests++;
    return page([], { uid: cnRole.uid }, cnRole.region);
  }, options);
  expect(domesticRequests).toBe(6);
  expect(empty.pools.every(({ records }) => !records.length)).toBe(true);
});

test("角色、区服、时区、六频段身份与逐抽 ID 校验失败时整次读取抛错", async () => {
  const link = parseZzzGachaLink(url(), role);
  const id = "9223372036854775807";
  const valid = row(id, "3");
  for (const [response, message] of [
    [() => page([row(id, "3", { uid: "1300000003" })]), /UID/u],
    [() => page([valid], { uid: "1300000003" }), /UID/u],
    [() => page([valid], { region: "prod_gf_us" }), /区服/u],
    [() => page([valid], { region_time_zone: undefined }), /时区/u],
    [() => page([valid], { region_time_zone: 15 }), /时区/u],
    [() => page([valid], { list: undefined }), /数量/u],
    [() => page([valid], { size: 0 }), /数量/u],
    [() => page(Array(21).fill(valid)), /数量/u],
    [() => page([row(id, "102")]), /频段/u],
    [() => page([row(id, "3", { real_gacha_type: "103" })]), /频段/u],
    [() => page([row(id, "3", { id: Number(id) })]), /编号/u],
    [() => page([row(id, "3", { name: token })]), /物品/u],
    [() => page([row(id, "3", { time: "2025-02-29 18:00:00" })]), /时间/u],
    [() => page([valid, valid]), /重复/u],
    [() => page([row("9223372036854775806", "3"), valid]), /顺序/u],
  ] as const) {
    await expect(readZzzGachaLink(link, async () => response(), options)).rejects.toThrow(message);
  }
  let calls = 0;
  await expect(readZzzGachaLink(link, async () => {
    calls++;
    return page([valid]);
  }, options)).rejects.toThrow(/重复/u);
  expect(calls).toBe(2);
  await expect(readZzzGachaLink(link, async () => page([valid]), { ...options, maxPages: 1 })).rejects.toThrow(/分页上限/u);
  let offset = 8;
  await expect(readZzzGachaLink(link, async () => page([], { uid: role.uid }, role.region, offset--), options)).rejects.toThrow(/时区/u);
  let passed = 0;
  const duplicateOtherBand: HoyoTransport = async (endpoint) => {
    passed++;
    if (endpoint.searchParams.get("page") === "2") return page([]);
    return page([row(id, endpoint.searchParams.get("real_gacha_type")!)]);
  };
  await expect(readZzzGachaLink(link, duplicateOtherBand, options)).rejects.toThrow(/重复/u);
  expect(passed).toBe(3);
  await expect(readZzzGachaLink(link, async () => page([]), options)).rejects.toMatchObject({ reason: "empty-unverified" });
});

test("过期、限频、风控、坏状态及超大响应均停止，不重试或泄露授权信息", async () => {
  const link = parseZzzGachaLink(url(), role);
  for (const [status, retcode, reason] of [[401, null, "expired"], [429, null, "rate-limited"], [200, -100, "expired"],
    [200, -110, "rate-limited"], [200, 1034, "risk"], [200, 10035, "risk"], [200, 10041, "risk"]] as const) {
    let requests = 0;
    const error = await readZzzGachaLink(link, async () => {
      requests++;
      return Response.json({ retcode, message: `Untrusted response: ${token}` }, { status });
    }, options).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ZzzGachaLinkError);
    expect(error).toMatchObject({ reason, status });
    expect(String(error)).not.toContain(token);
    expect(requests).toBe(1);
  }
  await expect(readZzzGachaLink(link, async () => Response.json({ data: { list: [] } }), options)).rejects.toThrow(/状态/u);
  await expect(readZzzGachaLink(link, async () => new Response("", { headers: { "Content-Length": "999999" } }), options))
    .rejects.toThrow(/大小上限/u);
  await expect(readZzzGachaLink(link, async () => new Response("x".repeat(256 * 1024 + 1)), options)).rejects.toThrow(/大小上限/u);
  await expect(readZzzGachaLink(link, async () => { throw new Error(`send ${token}`); }, options)).rejects
    .toThrow(/^绝区零抽卡请求未完成。$/u);
});

test("档案换绑或退出在边界取消已取得的分页数据", async () => {
  const parsed = parseZzzGachaLink(url(), role);
  const controller = new AbortController();
  let calls = 0;
  await expect(readZzzGachaLink(parsed, async () => {
    calls++;
    controller.abort();
    return page([row("9223372036854775807", "3")]);
  }, { ...options, signal: controller.signal })).rejects.toMatchObject({ code: "transport" });
  expect(calls).toBe(1);

  let verified = 0;
  await expect(readZzzGachaLink(parsed, async () => page([]), options, async () => {
    if (++verified === 2) throw new HoyoRequestError("profile-changed", "档案角色已变化。");
  })).rejects.toMatchObject({ code: "profile-changed" });
  expect(verified).toBe(2);
});

test('official overseas history accepts event ID zero and preserves the selected pool',async()=>{
 const link=parseZzzGachaLink(url(),role);let returned=false;
 const result=await readZzzGachaLink(link,async endpoint=>{
  if(!returned&&endpoint.searchParams.get('gacha_type')==='2'){returned=true;return page([row('9223372036854775807','2',{gacha_id:'0'})]);}
  return page([]);
 },options);
 expect(result.pools.find(pool=>pool.gachaType==='2')?.records[0]?.gachaId).toBe('0');
});
