import { expect, test } from "bun:test";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import { readStarRailPersonalRoster } from "../packages/hoyo-client/starrail-roster.ts";

const source: ProfileRequestContext = {
  qq: "42", profileId: 2, revision: "fixture", game: "sr",
  account: { cookie: "cookie_token=synthetic", stoken: "", stokenCookie: "", stuid: "42", ltuid: "", mid: "", ltoken: "" },
  device: { id: "slot-two-device", fp: "slot-two-fp", name: "", model: "", androidVersion: "", raw: {} },
  role: { uid: "500000123", region: "prod_qd_cn", nickname: "", gameBiz: "hkrpg_cn", chosen: false },
};

test("uses the fixed Star Rail index and basic roster with the same bound UID, then one detail request for trace statistics", async () => {
  const api = "/game_record/app/hkrpg/api/";
  for (const includeTalents of [false, true]) {
    const paths: string[] = [];
    let guards = 0;
    const basic = [{ id: 1220, level: 80 }, { id: 1407, level: 70 }];
    const skills = [{ id: 1220, level: 80, skills: [{ point_id: "1220001", remake: "普攻", level: 7 }] }];
    const data = await readStarRailPersonalRoster(source, async (url, init) => {
      paths.push(url.pathname.replace(api, ""));
      expect(url.origin).toBe("https://api-takumi-record.mihoyo.com");
      expect(url.searchParams.get("role_id")).toBe(source.role.uid);
      expect(url.searchParams.get("server")).toBe(source.role.region);
      expect(init.redirect).toBe("error");
      const headers = new Headers(init.headers);
      expect(headers.get("Cookie")).toBe(source.account.cookie);
      expect(headers.get("x-rpc-device_id")).toBe(source.device.id);
      const role = { role_id: source.role.uid, server: source.role.region, nickname: "测试角色", level: 70, avatar_id: 1220 };
      if (url.pathname.endsWith("/index")) return Response.json({ retcode: 0, data: { role, stats: { active_days: 700, achievement_count: 877, avatar_num: 2 } } });
      if (url.pathname.endsWith("/avatar/basic")) return Response.json({ retcode: 0, data: { role, list: basic } });
      expect(url.searchParams.get("need_wiki")).toBe("true");
      return Response.json({ retcode: 0, data: { role, avatar_list: skills } });
    }, { includeTalents }, async () => { guards++; });
    expect(paths).toEqual(includeTalents ? ["index", "avatar/basic", "avatar/info"] : ["index", "avatar/basic"]);
    expect(guards).toBeGreaterThanOrEqual(paths.length * 2);
    expect(data.roster).toEqual(basic);
    expect(data.talents).toEqual(includeTalents ? skills : []);
    expect(data.summary).toEqual({ nickname: "测试角色", level: 70, avatarId: 1220, achievement: 877, activeDays: 700, avatarCount: 2 });
  }
});

test("stops before the next read if the index or basic roster disagrees with the selected role", async () => {
  for (const badPath of ["/index", "/avatar/basic"]) {
    const paths: string[] = [];
    await expect(readStarRailPersonalRoster(source, async url => {
      paths.push(url.pathname);
      const uid = url.pathname.endsWith(badPath) ? "500000999" : source.role.uid;
      return Response.json({ retcode: 0, data: { role: { uid, region: source.role.region }, list: [] } });
    }, { includeTalents: true })).rejects.toThrow("UID 与当前档案不一致");
    expect(paths).toHaveLength(badPath === "/index" ? 1 : 2);
  }
});

test("distinguishes a valid empty roster from a truncated response", async () => {
  for (const list of [[], undefined]) {
    let calls = 0;
    const promise = readStarRailPersonalRoster(source, async url => {
      calls++;
      return Response.json({ retcode: 0, data: url.pathname.endsWith("/index") ? {role: { uid: source.role.uid }} : {list} });
    }, { includeTalents: true });
    if (list) expect((await promise).roster).toEqual([]);
    else await expect(promise).rejects.toThrow("缺少有效角色列表");
    expect(calls).toBe(2);
  }
});

test("renews expired credentials once, then replays the complete read in the same slot", async () => {
  let active = source, exchangeCount = 0;
  const calls: string[] = [];
  const refreshedCookie = "cookie_token=synthetic-new";
  const client = createHoyoClient(async (url, init) => {
    const cookie = new Headers(init.headers).get("cookie");
    const name = url.pathname.substring("/game_record/app/hkrpg/api/".length);
    expect(url.searchParams.get("role_id")).toBe(source.role.uid);
    expect(url.searchParams.get("server")).toBe(source.role.region);
    calls.push(cookie === refreshedCookie ? "new:" + name : "old:" + name);
    if (cookie !== refreshedCookie) return Response.json({ retcode: -100, message: "expired synthetic cookie" });
    return Response.json({ retcode: 0, data: name === "index"
      ? { role: { uid: source.role.uid, level: 70 } } : { list: [] } });
  }, {
    profiles: {
      async accountContext(qq, profileId) {
        expect([qq, profileId]).toEqual([source.qq, source.profileId]);
        return active;
      },
      async saveRefreshedCredentials(qq, profileId, revision, credentials) {
        expect([qq, profileId, revision]).toEqual([source.qq, source.profileId, source.revision]);
        active = { ...source, revision: "fixture-refreshed", account: { ...source.account, cookie: credentials.cookie } };
        return active;
      },
      async saveRoles() { throw new Error("名册不写入角色绑定"); },
    },
    async exchange(profile, options) {
      exchangeCount++;
      expect(profile.profileId).toBe(2);
      await options?.verifyProfile?.();
      return { cookie: refreshedCookie, ltoken: "" };
    },
  });
  const result = await client.fetchStarRailPersonalRoster(source, { includeTalents: true });
  expect(result).toMatchObject({ roster: [], revision: "fixture-refreshed", refreshedCookie: true });
  expect(calls).toEqual(["old:index", "new:index", "new:avatar/basic"]);
  expect(exchangeCount).toBe(1);
});

test("a private panel leaves the official basic roster usable only when the caller allows hidden talent data", async () => {
  const load = (allowHiddenTalents: boolean) => readStarRailPersonalRoster(source, async url => {
    if (url.pathname.endsWith("/index")) return Response.json({ retcode: 0, data: {} });
    if (url.pathname.endsWith("/basic")) return Response.json({ retcode: 0, data: { list: [{ id: 1002 }] } });
    return Response.json({ retcode: 10102, message: "private" });
  }, { includeTalents: true, allowHiddenTalents });
  expect(await load(true)).toMatchObject({ roster: [{ id: 1002 }], talents: [] });
  await expect(load(false)).rejects.toMatchObject({ retcode: 10102 });
});
