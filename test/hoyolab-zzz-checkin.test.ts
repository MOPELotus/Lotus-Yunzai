import { expect, test } from "bun:test";
import { runGameCheckinSequence } from "../lib/game-checkin-sequence.ts";
import { openHoYoLabZzzCheckin, type HoYoLabZzzRole } from "../packages/hoyo-client/hoyolab-zzz-checkin.ts";

const profile = {
  cookie: "ltuid_v2=810; ltoken_v2=v2_fixture-nap; ltmid_v2=fixture-mid",
  accountId: "810", realm: "US" as const, language: "JA_JP",
};
const deviceId = "123e4567-e89b-42d3-a456-426614174000";
const verifyProfile = async () => {};
const rolesUrl = "https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken?game_biz=nap_global";
const endpoint = "https://sg-act-public-api.hoyolab.com/event/luna/zzz/os";
const uid = "1300000001";
const japan = { uid, region: "prod_gf_jp", gameBiz: "nap_global" } as const satisfies HoYoLabZzzRole;
const america = { ...japan, region: "prod_gf_us" } as const satisfies HoYoLabZzzRole;
const rows = [japan, america].map(({ uid, region, gameBiz }) => ({ game_uid: uid, region, game_biz: gameBiz }));
const ok = (data: object) => Response.json({ retcode: 0, data });
const paramsFor = (region: string) => ({ act_id: "e202406031448091", uid, region, lang: "ja-jp" });

test("绝区零只用已核验 LToken，按同一角色的 UID/区服读取、提交、回读", async () => {
  const calls: string[] = [];
  const signed = new Set<string>();
  const reader = await openHoYoLabZzzCheckin(profile, async (url, init) => {
    const headers = new Headers(init.headers);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect(headers.get("cookie")).toBe(profile.cookie);
    expect(headers.get("origin")).toBe("https://act.hoyolab.com");
    expect(headers.has("ds")).toBe(false);
    expect(headers.has("x-rpc-challenge")).toBe(false);
    if (url.href === rolesUrl) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(headers.get("x-rpc-language")).toBe("ja");
      calls.push("roles");
      return ok({ list: rows, account_id: "810", ma_passport_region: "US" });
    }
    expect(headers.get("x-rpc-signgame")).toBe("zzz");
    if (init.method === "POST") {
      expect(url.href).toBe(`${endpoint}/sign`);
      expect(headers.get("x-rpc-client_type")).toBe("5");
      expect(headers.get("x-rpc-platform")).toBe("4");
      expect(headers.get("x-rpc-device_id")).toBe(deviceId);
      expect(headers.get("x-rpc-device_fp")).toBe(deviceId);
      const body = JSON.parse(String(init.body));
      expect(body).toEqual(paramsFor(body.region));
      calls.push(`POST ${body.region}`);
      signed.add(body.region);
      return ok({ role: { uid, region: body.region } });
    }
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(url.origin + url.pathname).toBe(`${endpoint}/info`);
    const region = url.searchParams.get("region")!;
    expect([...url.searchParams]).toHaveLength(4);
    expect(Object.fromEntries(url.searchParams)).toEqual(paramsFor(region));
    calls.push(`GET ${region}`);
    return ok({ uid, region, is_sign: signed.has(region), total_sign_day: signed.has(region) ? 2 : 1 });
  }, { verifyProfile, deviceId });
  expect(reader.roles).toEqual([japan, america]);
  for (const role of reader.roles) {
    expect(await runGameCheckinSequence({ ...reader.forRole(role, []), verifyCurrent: verifyProfile }))
      .toEqual({ status: "signed", totalSignDays: 2 });
  }
  expect(calls).toEqual(["roles", ...[japan, america].flatMap(({ region }) =>
    [`GET ${region}`, `POST ${region}`, `GET ${region}`])]);
});

test("绝区零拒绝普通 Cookie、黑名单、跨区回包和首次绑定的提交", async () => {
  let requested = 0;
  await expect(openHoYoLabZzzCheckin({ ...profile, cookie: "account_id=810; cookie_token=fixture" }, async () => {
    requested++;
    throw new Error("unexpected request");
  }, { verifyProfile })).rejects.toMatchObject({ code: "invalid-input" });
  expect(requested).toBe(0);

  let calls = 0;
  let reply = { is_sign: false, first_bind: true, uid, region: japan.region as string };
  const reader = await openHoYoLabZzzCheckin(profile, async (url, init) => {
    if (url.href === rolesUrl) return ok({ list: rows });
    calls++;
    expect(init.method).toBe("GET");
    return ok(reply);
  }, { verifyProfile });
  for (const role of reader.roles) expect(() => reader.forRole(role, [uid])).toThrow();
  expect(() => reader.forRole({ ...japan, region: "prod_gf_eu" }, [])).toThrow();
  expect(calls).toBe(0);
  const check = reader.forRole(japan, []);
  const sequence = { ...check, verifyCurrent: verifyProfile };
  expect(await runGameCheckinSequence(sequence)).toEqual({ status: "first-bind" });
  await expect(check.submit()).rejects.toMatchObject({ code: "invalid-input" });
  reply = { ...reply, first_bind: false, region: america.region };
  expect(await runGameCheckinSequence(sequence)).toMatchObject({ status: "failed", error: { code: "response" } });
  await expect(check.submit()).rejects.toMatchObject({ code: "invalid-input" });
  expect(calls).toBe(2);
});

test("绝区零顶层风险回执终止写链，未确认的提交只回读当前角色", async () => {
  for (const [response, status, reads] of [
    [() => ok({ is_risk: true, challenge: "synthetic-private" }), "failed", 1],
    [() => new Response(null, { status: 503 }), "unconfirmed", 2],
  ] as const) {
    const sent: string[] = [];
    const reader = await openHoYoLabZzzCheckin(profile, async (url, init) => {
      if (url.href === rolesUrl) return ok({ list: rows });
      sent.push(init.method!);
      if (init.method === "POST") return response();
      expect(Object.fromEntries(url.searchParams)).toEqual(paramsFor(japan.region));
      return ok({ is_sign: false, uid, region: japan.region });
    }, { verifyProfile });
    const role = reader.forRole(japan, []);
    const result = await runGameCheckinSequence({ ...role, verifyCurrent: verifyProfile });
    expect(result).toMatchObject({ status });
    if (reads === 1) expect(result).toMatchObject({ error: { reason: "risk" } });
    if ("error" in result) expect(String(result.error)).not.toContain("synthetic-private");
    await expect(role.submit()).rejects.toMatchObject({ code: "invalid-input" });
    expect(sent).toEqual(reads === 1 ? ["GET", "POST"] : ["GET", "POST", "GET"]);
  }
});

test('ZZZ official info accepts an unreported empty region while retaining role and game checks',async()=>{
 let state:Record<string,unknown>={is_sign:false,region:'',total_sign_day:0};
 const reader=await openHoYoLabZzzCheckin(profile,async url=>url.pathname.includes('getUserGameRolesByLtoken')?ok({list:rows}):ok(state),{verifyProfile});
 const selected=reader.forRole(japan,[]);expect(await selected.readInfo()).toMatchObject({signed:false,totalSignDays:0});
 for(const invalid of[{uid:'1300000009'},{game_biz:'nap_cn'},{role:{region:''}},{region:'prod_gf_sg'}]){state={is_sign:false,region:'',...invalid};await expect(selected.readInfo()).rejects.toMatchObject({code:'response'});}
});
