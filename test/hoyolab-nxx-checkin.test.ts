import { expect, test } from "bun:test";
import { runGameCheckinSequence } from "../lib/game-checkin-sequence.ts";
import { openHoYoLabNxxCheckin, type HoYoLabNxxRole } from "../packages/hoyo-client/hoyolab-nxx-checkin.ts";

const profile = {
  cookie: "ltuid_v2=910; ltoken_v2=v2_fixture-nxx; ltmid_v2=fixture-mid",
  accountId: "910", realm: "EU" as const, language: "EN_US",
};
const deviceId = "123e4567-e89b-42d3-a456-426614174000";
const verifyProfile = async () => {};
const directory = "https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken?game_biz=nxx_global";
const endpoint = "https://sg-act-public-api.hoyolab.com/event/luna/nxx/os";
const role = { uid: "100000042", region: "glb_prod_wd01", gameBiz: "nxx_global" } as const satisfies HoYoLabNxxRole;
const row = { game_uid: role.uid, region: role.region, game_biz: role.gameBiz };
const params = { act_id: "e202202281857121", uid: role.uid, region: role.region, lang: "en-us" };
const ok = (data: object) => Response.json({ retcode: 0, data });

test("未定国际服以 LToken 查国际服角色，固定 Luna 路径和四字段签到后回读", async () => {
  const calls: string[] = [];
  let signed = false;
  const checkin = await openHoYoLabNxxCheckin(profile, async (url, init) => {
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe(profile.cookie);
    expect(init.redirect).toBe("error");
    calls.push(`${init.method} ${url.origin}${url.pathname}`);
    if (url.href === directory) {
      expect(init.method).toBe("GET");
      expect(headers.get("x-rpc-language")).toBe("en");
      return ok({ list: [{ ...row, aid: "910", mid: "fixture-mid", ma_passport_region: "EU" }] });
    }
    expect(headers.get("x-rpc-signgame")).toBe("nxx");
    expect(headers.has("x-rpc-challenge")).toBe(false);
    if (init.method === "POST") {
      expect(url.href).toBe(`${endpoint}/sign`);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-rpc-device_id")).toBe(deviceId);
      expect(headers.get("x-rpc-device_fp")).toBe(deviceId);
      expect(JSON.parse(String(init.body))).toEqual(params);
      signed = true;
      return ok({ role: { uid: role.uid, region: role.region } });
    }
    expect(init.body).toBeUndefined();
    expect([...url.searchParams]).toHaveLength(4);
    expect(Object.fromEntries(url.searchParams)).toEqual(params);
    return ok({ is_sign: signed, uid: role.uid, region: role.region, total_sign_day: signed ? 2 : 1 });
  }, { verifyProfile, deviceId });
  expect(checkin.roles).toEqual([role]);
  expect(await runGameCheckinSequence({ ...checkin.forRole(role, []), verifyCurrent: verifyProfile }))
    .toEqual({ status: "signed", totalSignDays: 2 });
  await expect(checkin.forRole(role, []).submit()).rejects.toMatchObject({ code: "invalid-input" });
  expect(calls).toEqual([
    `GET ${directory.split("?")[0]}`, `GET ${endpoint}/info`, `POST ${endpoint}/sign`, `GET ${endpoint}/info`,
  ]);
});

test("未定全球服活动拒绝台服目录及角色，黑名单和未绑定 UID 均不查询活动", async () => {
  let requests = 0;
  const active = await openHoYoLabNxxCheckin(profile, async (url) => {
    requests++;
    expect(url.href).toBe(directory);
    return ok({ list: [row] });
  }, { verifyProfile });
  expect(() => active.forRole({ ...role, region: "tw_prod_wd01" }, [])).toThrow();
  expect(() => active.forRole({ ...role, uid: "100000043" }, [])).toThrow();
  expect(() => active.forRole(role, [role.uid])).toThrow();
  expect(requests).toBe(1);
  for (const incompatible of [
    { ...row, game_biz: "nxx_tw", region: "tw_prod_wd01" },
    { ...row, region: "tw_prod_wd01" },
    { ...row, game_biz: "nxx_cn" },
  ]) {
    await expect(openHoYoLabNxxCheckin(profile, async () => ok({ list: [incompatible] }), { verifyProfile }))
      .rejects.toMatchObject({ code: "response" });
  }
});

test("未定国际服风控不回读，未确认提交只回读原角色一次", async () => {
  for (const scenario of [
    { response: () => ok({ is_risk: true }), status: "failed", methods: ["GET", "POST"] },
    { response: () => new Response(null, { status: 503 }), status: "unconfirmed", methods: ["GET", "POST", "GET"] },
  ]) {
    const methods: string[] = [];
    const checkin = await openHoYoLabNxxCheckin(profile, async (url, init) => {
      if (url.href === directory) return ok({ list: [row] });
      methods.push(init.method!);
      if (init.method === "POST") return scenario.response();
      expect(Object.fromEntries(url.searchParams)).toEqual(params);
      return ok({ is_sign: false });
    }, { verifyProfile });
    const selected = checkin.forRole(role, []);
    expect(await runGameCheckinSequence({ ...selected, verifyCurrent: verifyProfile })).toMatchObject({ status: scenario.status });
    await expect(selected.submit()).rejects.toMatchObject({ code: "invalid-input" });
    expect(methods).toEqual(scenario.methods);
  }
});
