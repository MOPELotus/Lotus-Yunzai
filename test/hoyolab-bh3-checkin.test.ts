import { expect, test } from "bun:test";
import { runGameCheckinSequence } from "../lib/game-checkin-sequence.ts";
import { openHoYoLabBh3Checkin, type HoYoLabBh3Role } from "../packages/hoyo-client/hoyolab-bh3-checkin.ts";

const profile = {
  cookie: "ltuid=880; ltoken=fixture-bh3", accountId: "880", realm: "EU" as const, language: "EN_US",
};
const deviceId = "123e4567-e89b-42d3-a456-426614174000";
const verifyProfile = async () => {};
const directory = "https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken?game_biz=bh3_global";
const endpoint = "https://sg-act-public-api.hoyolab.com/event/mani";
const infoUrl = `${endpoint}/info?lang=en-us&act_id=e202110291205111`;
const signUrl = `${endpoint}/sign?lang=en-us`;
const asia = { uid: "100001", region: "asia01", gameBiz: "bh3_global" } as const satisfies HoYoLabBh3Role;
const europe = { ...asia, region: "eur01" } as const satisfies HoYoLabBh3Role;
const america = { ...asia, uid: "200002", region: "usa01" } as const satisfies HoYoLabBh3Role;
const rows = [asia, europe, america].map(({ uid, region, gameBiz }) => ({ game_uid: uid, region, game_biz: gameBiz }));
const ok = (data: object) => Response.json({ retcode: 0, data });

test("崩坏3国际服使用 LToken 和 /mani 账号默认签到，最终状态不标记角色", async () => {
  let signed = false;
  const calls: string[] = [];
  const checkin = await openHoYoLabBh3Checkin(profile, async (url, init) => {
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe(profile.cookie);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    calls.push(`${init.method} ${url.href}`);
    if (url.href === directory) return ok({ list: rows });
    expect(headers.get("x-rpc-signgame")).toBe("bh3");
    for (const header of ["ds", "x-rpc-device_id", "x-rpc-device_fp", "x-rpc-platform", "x-rpc-client_type"]) {
      expect(headers.has(header)).toBe(false);
    }
    if (url.href === signUrl) {
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init.body))).toEqual({ act_id: "e202110291205111" });
      signed = true;
      return ok({ region: europe.region });
    }
    expect(init.body).toBeUndefined();
    return ok({ is_sign: signed, total_sign_day: signed ? "02" : 1,
      role: { uid: europe.uid, region: europe.region } });
  }, { verifyProfile, deviceId });
  expect(checkin.roles).toEqual([asia, europe, america]);
  expect(await checkin.readInfo()).toEqual({ signed: false, firstBind: false, totalSignDays: 1 });
  await expect(checkin.submit({ blockedUids: [america.uid] })).rejects.toMatchObject({ code: "invalid-input" });
  const first = checkin.submit({ blockedUids: [] });
  await expect(checkin.submit({ blockedUids: [] })).rejects.toMatchObject({ code: "invalid-input" });
  expect(await first).toBe("accepted");
  expect(await checkin.readInfo()).toEqual({ signed: true, firstBind: false, totalSignDays: 2 });
  expect(calls).toEqual([`GET ${directory}`, `GET ${infoUrl}`, `POST ${signUrl}`, `GET ${infoUrl}`]);
});

test("崩坏3国际服拒绝非 HoYoLAB LToken、错误地区和冲突的账号角色", async () => {
  let requests = 0;
  await expect(openHoYoLabBh3Checkin({ ...profile, cookie: "account_id=880; cookie_token=wrong-kind" }, async () => {
    requests++;
    return ok({ list: rows });
  }, { verifyProfile })).rejects.toMatchObject({ code: "invalid-input" });
  expect(requests).toBe(0);
  for (const list of [
    [rows[0], rows[0]], [{ ...rows[0], region: "android01" }], [{ ...rows[0], game_biz: "bh3_cn" }],
    [{ ...rows[0], account_id: "881" }], [{ ...rows[0], ma_passport_region: "SG" }],
  ]) {
    await expect(openHoYoLabBh3Checkin(profile, async () => ok({ list }), { verifyProfile }))
      .rejects.toMatchObject({ code: "response" });
  }

  let response: object = {};
  const checkin = await openHoYoLabBh3Checkin(profile, async (url, init) => {
    if (url.href === directory) return ok({ list: rows });
    expect(init.method).toBe("GET");
    return ok(response);
  }, { verifyProfile });
  for (const observed of [
    { is_sign: true }, { is_sign: false, first_bind: true },
    { is_sign: false, uid: america.uid, region: europe.region },
  ]) {
    response = observed;
    if (Object.hasOwn(observed, "uid")) await expect(checkin.readInfo()).rejects.toMatchObject({ code: "response" });
    else await checkin.readInfo();
    await expect(checkin.submit({ blockedUids: [] })).rejects.toMatchObject({ code: "invalid-input" });
  }
});

test("崩坏3官方受理或超时只用默认状态回读，风控与非零回执直接停止", async () => {
  for (const scenario of [
    { post: () => ok({}), after: true, status: "signed", calls: ["GET", "POST", "GET"] },
    { post: () => new Response(null, { status: 503 }), after: false, status: "unconfirmed", calls: ["GET", "POST", "GET"] },
    { post: () => ok({ gt_result: { is_risk: true } }), status: "failed", calls: ["GET", "POST"] },
    { post: () => Response.json({ retcode: -5003 }), status: "failed", calls: ["GET", "POST"] },
  ]) {
    const calls: string[] = [];
    const checkin = await openHoYoLabBh3Checkin(profile, async (url, init) => {
      if (url.href === directory) return ok({ list: rows });
      calls.push(init.method!);
      return init.method === "POST" ? scenario.post() : ok({ is_sign: calls.length > 1 && scenario.after === true });
    }, { verifyProfile });
    expect(await runGameCheckinSequence({
      readInfo: checkin.readInfo, submit: () => checkin.submit({ blockedUids: [] }), verifyCurrent: verifyProfile,
    })).toMatchObject({ status: scenario.status });
    expect(calls).toEqual(scenario.calls);
  }
});
