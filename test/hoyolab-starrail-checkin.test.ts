import { expect, test } from "bun:test";
import { runGameCheckinSequence } from "../lib/game-checkin-sequence.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";
import { openHoYoLabStarRailCheckin } from "../packages/hoyo-client/hoyolab-starrail-checkin.ts";

const profile = {
  cookie: "ltuid_v2=701; ltoken_v2=v2_fixture-token; ltmid_v2=fixture-mid",
  accountId: "701", realm: "EU" as const, language: "ZH_TW",
};
const deviceId = "123e4567-e89b-42d3-a456-426614174000";
const verifyProfile = async () => {};
const directoryUrl = "https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken";
const activityUrl = "https://sg-act-public-api.hoyolab.com/event/luna/hkrpg/os";
const gameBiz = "hkrpg_global";
const uid = "8000000001";
const asia = { uid, region: "prod_official_asia" } as const;
const cht = { uid, region: "prod_official_cht" } as const;
const asiaRow = { game_uid: uid, region: asia.region, game_biz: gameBiz, is_chosen: true };
const chtRow = { game_uid: uid, region: cht.region, game_biz: gameBiz, is_chosen: false };
const ok = (data: object) => Response.json({ retcode: 0, data });
const callsFor = (region: string) => ({ act_id: "e202303301540311", uid, region, lang: "zh-tw" });

test("星铁国际服以独立 LToken 读取角色目录，同 UID 跨区各自先读、提交和回读", async () => {
  const sent: Array<{ method: string; region: string }> = [];
  const signed = new Set<string>();
  const transport: HoyoTransport = async (url, init) => {
    const headers = new Headers(init.headers);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect(headers.get("cookie")).toBe(profile.cookie);
    expect(headers.get("origin")).toBe("https://act.hoyolab.com");
    for (const key of ["ds", "x-rpc-challenge"]) expect(headers.has(key)).toBe(false);
    if (url.href === directoryUrl + "?game_biz=hkrpg_global") {
      expect(init.method).toBe("GET");
      expect(headers.get("x-rpc-language")).toBe("zh-tw");
      return ok({ list: [asiaRow, { ...chtRow, aid: 701, mid: "fixture-mid", ma_passport_region: "EU" }] });
    }
    expect(headers.get("x-rpc-signgame")).toBe("hkrpg");
    if (init.method === "POST") {
      expect(url.href).toBe(`${activityUrl}/sign`);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-rpc-client_type")).toBe("5");
      expect(headers.get("x-rpc-platform")).toBe("4");
      expect(headers.get("x-rpc-device_id")).toBe(deviceId);
      expect(headers.get("x-rpc-device_fp")).toBe(deviceId);
      const params = JSON.parse(String(init.body));
      expect(params).toEqual(callsFor(params.region));
      signed.add(params.region);
      sent.push({ method: "POST", region: params.region });
      return ok({ role: { uid, server: params.region } });
    }
    expect(url.origin + url.pathname).toBe(`${activityUrl}/info`);
    expect(init).toMatchObject({ method: "GET" });
    expect(init.body).toBeUndefined();
    const region = url.searchParams.get("region")!;
    expect([...url.searchParams]).toHaveLength(4);
    expect(Object.fromEntries(url.searchParams)).toEqual(callsFor(region));
    sent.push({ method: "GET", region });
    return ok({ is_sign: signed.has(region), uid, region, total_sign_day: signed.has(region) ? "2" : 1 });
  };
  const session = await openHoYoLabStarRailCheckin(profile, transport, { verifyProfile, deviceId });
  expect(session.roles).toEqual([
    { ...asia, gameBiz, chosen: true }, { ...cht, gameBiz, chosen: false },
  ]);
  for (const role of session.roles) {
    const result = await runGameCheckinSequence({
      ...session.forRole(role, ["6000000002"]), verifyCurrent: verifyProfile,
    });
    expect(result).toEqual({ status: "signed", totalSignDays: 2 });
    await expect(session.forRole(role, []).submit()).rejects.toMatchObject({ code: "invalid-input" });
  }
  expect(sent).toEqual([asia, cht].flatMap(({ region }) => ["GET", "POST", "GET"].map(method => ({ method, region }))));
});

test("未绑定角色和黑名单不出站，已签到、首绑和冲突回包阻止提交", async () => {
  let posts = 0;
  let reads = 0;
  let data: object = {};
  const session = await openHoYoLabStarRailCheckin(profile, async (url, init) => {
    if (url.href.startsWith(directoryUrl)) return ok({ list: [asiaRow, chtRow] });
    if (init.method === "POST") posts++;
    else reads++;
    return ok(data);
  }, { verifyProfile });
  for (const role of [asia, cht]) expect(() => session.forRole(role, [uid])).toThrow();
  expect(() => session.forRole({ uid, region: "prod_official_eur" }, [])).toThrow();
  expect(() => session.forRole(asia, ["not-a-uid"])).toThrow();
  const reader = session.forRole(asia, []);
  await expect(reader.submit()).rejects.toMatchObject({ code: "invalid-input" });
  expect(reads).toBe(0);
  for (const [state, status] of [
    [{ is_sign: true }, "already"],
    [{ is_sign: false, first_bind: true }, "first-bind"],
    [{ is_sign: false, role: { uid, region: cht.region } }, "failed"],
    [{ is_sign: false, role: { uid: "7000000001", region: asia.region } }, "failed"],
    [{ is_sign: false, total_sign_day: 32 }, "failed"],
  ] as const) {
    data = state;
    expect(await runGameCheckinSequence({ ...reader, verifyCurrent: verifyProfile })).toMatchObject({ status });
    await expect(reader.submit()).rejects.toMatchObject({ code: "invalid-input" });
  }
  expect(posts).toBe(0);
});

test("星铁目录拒绝绑定身份不符和缺少独立 HoYoLAB LToken 的档案", async () => {
  let requested = false;
  await expect(openHoYoLabStarRailCheckin({
    ...profile, cookie: "account_id=701; cookie_token=wrong-credential",
  }, async () => {
    requested = true;
    return ok({ list: [asiaRow] });
  }, { verifyProfile })).rejects.toMatchObject({ code: "invalid-input" });
  expect(requested).toBe(false);
  for (const list of [
    [asiaRow, asiaRow], [{ ...asiaRow, region: "prod_gf_cn" }], [{ ...asiaRow, game_biz: "hkrpg_cn" }],
    [{ ...asiaRow, aid: "702" }], [{ ...asiaRow, mid: "different-mid" }], [{ ...asiaRow, ma_passport_region: "SG" }],
  ]) {
    await expect(openHoYoLabStarRailCheckin(profile, async () => ok({ list }), { verifyProfile }))
      .rejects.toMatchObject({ code: "response" });
  }
});

test("星铁国际服非零回执不推断已签到，风险或限流不回读，未知结果只查一次", async () => {
  for (const scenario of [
    { response: () => Response.json({ retcode: -5003, data: null }), status: "failed", reads: 1 },
    { response: () => new Response(null, { status: 503 }), after: true, status: "signed", reads: 2 },
    { response: () => ok({ gt_result: { is_risk: true, challenge: "private" } }), status: "failed", reads: 1, reason: "risk" },
    { response: () => ok({ is_risk: "true" }), after: false, status: "unconfirmed", reads: 2 },
    { response: () => new Response(null, { status: 429 }), status: "failed", reads: 1, reason: "rate-limited" },
  ]) {
    let posts = 0;
    let reads = 0;
    const session = await openHoYoLabStarRailCheckin(profile, async (url, init) => {
      if (url.href.startsWith(directoryUrl)) return ok({ list: [asiaRow] });
      if (init.method === "POST") {
        posts++;
        return scenario.response();
      }
      reads++;
      expect(url.searchParams.get("uid")).toBe(uid);
      expect(url.searchParams.get("region")).toBe(asia.region);
      return ok({ is_sign: reads > 1 && scenario.after === true });
    }, { verifyProfile });
    const reader = session.forRole(asia, []);
    const result = await runGameCheckinSequence({ ...reader, verifyCurrent: verifyProfile });
    expect(result).toMatchObject({ status: scenario.status });
    if (scenario.reason) expect(result).toMatchObject({ error: { reason: scenario.reason } });
    await expect(session.forRole(asia, []).submit()).rejects.toMatchObject({ code: "invalid-input" });
    expect({ posts, reads }).toEqual({ posts: 1, reads: scenario.reads });
  }
});
