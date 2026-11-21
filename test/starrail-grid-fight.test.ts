import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import { GameRecordRequestError } from "../packages/hoyo-client/game-record.ts";
import { readStarRailGridFight } from "../packages/hoyo-client/starrail-grid-fight.ts";

const source: ProfileRequestContext = {
  qq: "42", profileId: 2, revision: "grid-fixture", game: "sr",
  role: { uid: "500000123", region: "prod_qd_cn", gameBiz: "hkrpg_cn", nickname: "合成开拓者", chosen: true },
  account: { cookie: "cookie_token=fixture-cookie", stoken: "", stuid: "", stokenCookie: "", ltuid: "", ltoken: "", mid: "" },
  device: { id: "device-2", fp: "fingerprint-2", name: "fixture", model: "Android", androidVersion: "13", raw: {} },
};

test("signs the grid-fight read for just the selected national or channel role and device", async () => {
  const brief = { season_level: 0, weekly_score_cur: 700, weekly_score_max: 800 };
  const records = [{ brief: { remain_hp: 1 }, lineup: { front_roles: [] } }];
  let guards = 0;
  const result = await readStarRailGridFight(source, async (url, init) => {
    expect(url.href).toBe("https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/grid_fight?role_id=500000123&server=prod_qd_cn");
    const headers = new Headers(init.headers);
    expect(headers.get("Cookie")).toBe("cookie_token=fixture-cookie");
    expect(headers.get("x-rpc-device_id")).toBe("device-2");
    expect(headers.get("x-rpc-device_fp")).toBe("fingerprint-2");
    expect(headers.get("x-rpc-client_type")).toBe("5");
    const [t, r, hash] = headers.get("DS")!.split(",");
    expect(hash).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${t}&r=${r}&b=&q=${url.search.slice(1)}`).digest("hex"));
    expect([init.method, init.body, init.credentials, init.redirect]).toEqual(["GET", undefined, "omit", "error"]);
    return Response.json({ retcode: 0, data: { role: { uid: source.role.uid, server: source.role.region }, grid_fight_brief: brief, grid_fight_archive_list: records } });
  }, {}, async () => { guards++; });
  expect(result).toEqual({ brief, records });
  expect(guards).toBe(2);
});

test("rejects unsynced, cross-region, foreign payloads and invalid game archive structures", async () => {
  const offline = async () => { throw new Error("must never request"); };
  for (const role of [
    { ...source.role, region: "" }, { ...source.role, region: "prod_gf_cn" }, { ...source.role, gameBiz: "" },
  ]) await expect(readStarRailGridFight({ ...source, role }, offline, {})).rejects.toMatchObject({ code: "invalid-input" });
  await expect(readStarRailGridFight({ ...source, device: { ...source.device, fp: "" } }, offline, {}))
    .rejects.toMatchObject({ code: "invalid-input" });
  for (const data of [
    { role: { uid: "500000456" } }, { grid_fight_brief: { server: "prod_gf_cn" } },
    { grid_fight_brief: [], grid_fight_archive_list: [] },
    { grid_fight_brief: {}, grid_fight_archive_list: [42] },
    { grid_fight_archive_list: [{ brief: {} }] },
  ]) await expect(readStarRailGridFight(source, async () => Response.json({ retcode: 0, data }), {}))
    .rejects.toMatchObject({ code: "response" });
  for (const data of [null, {}, { grid_fight_archive_list: [] }]) {
    expect(await readStarRailGridFight(source, async () => Response.json({ retcode: 0, data }), {}))
      .toEqual({ brief: undefined, records: [] });
  }
});

test("routes cookie expiry into existing renewal and blocks risk without proceeding", async () => {
  const risk = await readStarRailGridFight(source, async () => Response.json({ retcode: 0, data: {} },
    { headers: { "x-rpc-aigis": "{\"challenge\":true}" } }), {}).catch(error => error);
  expect(risk).toBeInstanceOf(GameRecordRequestError);
  expect(risk.reason).toBe("risk");
  await expect(readStarRailGridFight(source, async () => Response.json({ retcode: -100, data: null }), {}))
    .rejects.toMatchObject({ reason: "expired" });
});

test("retries once after refreshing the selected profile with its original role and device", async () => {
  let current = source;
  const calls: string[] = [];
  const cookie = "cookie_token=refreshed-fixture";
  let exchanges = 0;
  const client = createHoyoClient(async (url, init) => {
    expect(url.search).toBe("?role_id=500000123&server=prod_qd_cn");
    const headers = new Headers(init.headers);
    expect(headers.get("x-rpc-device_fp")).toBe("fingerprint-2");
    const usedCookie = headers.get("Cookie")!;
    calls.push(usedCookie);
    return usedCookie === cookie
      ? Response.json({ retcode: 0, data: { grid_fight_brief: { season_level: 8 } } })
      : Response.json({ retcode: -100, data: null });
  }, {
    profiles: {
      async accountContext(qq, slot) { expect([qq, slot]).toEqual(["42", 2]); return current; },
      async saveRefreshedCredentials(qq, slot, revision, credentials) {
        expect([qq, slot, revision]).toEqual(["42", 2, source.revision]);
        current = { ...current, revision: "grid-renewed", account: { ...current.account, cookie: credentials.cookie } };
        return current;
      },
      async saveRoles() { throw Error("game record must not change roles"); },
    },
    async exchange(profile, options) {
      exchanges++;
      expect(profile.profileId).toBe(2);
      await options?.verifyProfile?.();
      return { cookie, ltoken: "" };
    },
  });
  expect(await client.fetchStarRailGridFight(source)).toEqual({
    brief: { season_level: 8 }, records: [], revision: "grid-renewed", refreshedCookie: true,
  });
  expect(calls).toEqual([source.account.cookie, cookie]);
  expect(exchanges).toBe(1);
});
