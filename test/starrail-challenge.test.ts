import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "../packages/account/index.ts";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { readStarRailChallenge } from "../packages/hoyo-client/starrail-challenge.ts";
import { buildStarRailAbyssSections } from "../plugins/starrail/challenge-card.js";
import { normalizeStarRailChallenge, parseChallengeQuery } from "../plugins/starrail/challenge-model.ts";

const profile: ProfileRequestContext = {
  qq: "42", profileId: 2, revision: "synthetic-revision", game: "sr",
  account: { cookie: "ltuid=12; ltoken=synthetic", stuid: "", ltuid: "12", stoken: "", ltoken: "synthetic", stokenCookie: "", mid: "" },
  device: { id: "device-2", fp: "fingerprint-2", name: "Test", model: "Android", androidVersion: "13", raw: {} },
  role: { uid: "100000123", nickname: "开拓者", region: "prod_gf_cn", gameBiz: "hkrpg_cn", chosen: false },
};

function verifySignature(endpoint: URL, headers: Headers) {
  const [time, nonce, signature] = headers.get("DS")!.split(",");
  const values = new URLSearchParams(endpoint.searchParams);
  values.sort();
  const query = Array.from(values, ([key, value]) => `${key}=${value}`).join("&");
  const expected = createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${time}&r=${nonce}&b=&q=${query}`).digest("hex");
  expect(signature).toBe(expected);
}

test("preserves challenge aliases, separate archive commands and profile suffixes", () => {
  expect(parseChallengeQuery("*混沌")).toMatchObject({ kinds: ["hall"], period: "current", profileId: 1 });
  expect(parseChallengeQuery("#星铁上期简易忘却之庭 2")).toMatchObject({ kinds: ["hall"], period: "last", profileId: 2, simple: true });
  expect(parseChallengeQuery("*最新深渊")).toMatchObject({ kinds: ["hall", "story", "boss"], latest: true });
  for (const command of ["*混沌图鉴", "#星铁混沌256", "#深渊", "*角色记录", "*异相仲裁123456789"]) {
    expect(parseChallengeQuery(command)).toBeUndefined();
  }
});

test("requests only the selected roles and periods, signs decoded fields, and falls back for recognized private data", async () => {
  const calls: string[] = [];
  let guards = 0;
  const result = await readStarRailChallenge(profile, async (endpoint, init) => {
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(endpoint.origin).toBe("https://api-takumi-record.mihoyo.com");
    expect(endpoint.searchParams.get("role_id")).toBe(profile.role.uid);
    const headers = new Headers(init.headers);
    expect(headers.get("Cookie")).toBe(profile.account.cookie);
    expect(headers.get("x-rpc-device_id")).toBe("device-2");
    verifySignature(endpoint, headers);
    const path = endpoint.pathname.split("/").at(-1)!;
    const schedule = endpoint.searchParams.get("schedule_type");
    const detail = endpoint.searchParams.has("need_all");
    calls.push([path, schedule, detail].join(":"));
    if (detail && path === "challenge") return Response.json({ retcode: 10102 });
    return Response.json({ retcode: 0, data: { role: { role_id: profile.role.uid, server: profile.role.region } } });
  }, { kinds: ["hall", "peak"], period: "last", simple: false }, async () => { guards++; });
  expect(calls).toEqual(["challenge:2:true", "challenge:2:false", "challenge_peak:3:true"]);
  expect(guards).toBe(6);
  expect(result.records.map(({ kind, simple }) => [kind, simple])).toEqual([["hall", true], ["peak", false]]);
});

test("verification, rate limiting, credential failures and a mismatched response do not trigger simple queries", async () => {
  const options = { kinds: ["hall"], period: "current", simple: false } as const;
  for (const [response, reason] of [
    [Response.json({ retcode: 0 }, { headers: { "x-rpc-aigis": "verification-required" } }), "risk"],
    [Response.json({ retcode: 0 }, { status: 429 }), "rate-limited"],
    [Response.json({ retcode: -100 }), "expired"],
  ] as const) {
    let calls = 0;
    await expect(readStarRailChallenge(profile, async () => {
      calls++;
      return response;
    }, options)).rejects.toMatchObject({ reason });
    expect(calls).toBe(1);
  }
  await expect(readStarRailChallenge(profile, async () =>
    Response.json({ retcode: 0, data: { role: { role_id: "100000124" } } }), options))
    .rejects.toMatchObject({ code: "response" });
  await expect(readStarRailChallenge({ ...profile, role: { ...profile.role, region: "prod_official_usa" } }, async () => {
    throw new Error("must reject before requesting");
  }, options)).rejects.toMatchObject({ code: "invalid-input" });
});

test("discard a response when the selected profile changes after the request", async () => {
  let valid = true;
  await expect(readStarRailChallenge(profile, async () => {
    valid = false;
    return Response.json({ retcode: 0, data: {} });
  }, { kinds: ["hall", "story"], period: "current", simple: true }, async () => {
    if (!valid) throw new Error("fixture changed");
  })).rejects.toThrow("fixture changed");
});

test("renders the deepest awakened floor and uses the official start date to choose the latest mode", () => {
  const date = (day: number) => ({ year: 2026, month: 11, day });
  const max = {
    name: "混沌回忆其十二星启模式", maze_id: 112, star_num: 4, is_tierce: true,
    node_1: { avatars: [{ id: 1302, level: 80, rarity: 5, rank: 0 }] },
    node_2: { round_num: 2 }, node_3: { round_num: 0 },
  };
  const query = parseChallengeQuery("*最新深渊")!;
  const results = normalizeStarRailChallenge([
    { kind: "hall", schedule: "1", simple: false, data: {
      begin_time: date(17), end_time: date(30), max_floor: "混沌回忆其十二", star_num: 36, extra_star_num: 1,
      all_floor_detail: [max, { name: "混沌回忆其十二", maze_id: 112, star_num: 3 }, { name: "十一", maze_id: 111, star_num: 3 }],
    } },
    { kind: "story", schedule: "1", simple: false, data: { groups: [{ status: "New", begin_time: date(3), end_time: date(30) }] } },
    { kind: "boss", schedule: "1", simple: false, data: { groups: [{ status: "New", begin_time: date(24), end_time: date(30) }] } },
  ], query, id => id === "1302" ? "银枝" : undefined, Date.parse("2026-11-19T12:00:00+08:00"));
  expect(results.map(({ kind }) => kind)).toEqual(["hall"]);
  const sections = buildStarRailAbyssSections({ results });
  expect(sections[0]).toMatchObject({
    floorTitle: "混沌回忆其十二星启模式", floorStars: 4, floorMaxStars: 4,
    nodes: [{ avatars: [{ name: "银枝", rank: 0 }] }, { round: 2 }, { round: 0 }],
  });
});

test("historical arbiter fights retain per-period counts and match knight records by known stage ID", () => {
  const query = parseChallengeQuery("*往期仲裁")!;
  const records = [
    { group: { status: "New", game_version: "4.6", name_mi18n: "本期主题" }, battle_num: 4, boss_stars: 3, mob_stars: 6,
      mob_infos: [{ maze_id: 2, name: "骑士战" }], mob_records: [{ maze_id: 1, star_num: 0 }, { maze_id: 2, star_num: 3 }] },
    { group: { status: "End", game_version: "4.5", name_mi18n: "往期主题" }, battle_num: 1, boss_stars: 2, mob_stars: 3 },
  ];
  const results = normalizeStarRailChallenge([{ kind: "peak", schedule: "3", simple: false,
    data: { challenge_peak_records: records } }], query, () => undefined);
  expect(results[0]?.peak.map(({ title, battleNum }) => [title, battleNum])).toEqual([["4.6 本期主题", 4], ["4.5 往期主题", 1]]);
  expect(results[0]?.peak[0]?.mobs[0]?.stars).toBe(3);
});

test("expires and renews the selected local profile once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-sr-challenge-profile-"));
  const qq = "42";
  try {
    const writeProfile = (id: number, cookie: string) => writeFile(join(directory, id === 1 ? "42.yaml" : "42-2.yaml"), `
version: 1
user: { qq: "42" }
profile: { id: ${id} }
account:
  cookie: "cookie_token=${cookie}"
  stoken: stoken-fixture
  stuid: "42"
  game_roles: { sr: [{ uid: "${profile.role.uid}", region: prod_gf_cn, game_biz: hkrpg_cn }] }
  current_uid: { sr: "${profile.role.uid}" }
device: { id: "account-device-${id}" }
`);
    await writeProfile(1, "other-profile");
    await writeProfile(2, "old-profile");
    const profiles = createProfileStore(directory);
    const source = await profiles.requestContext(qq, 2, "sr");
    let recoveries = 0;
    const attempts: string[] = [];
    const client = createHoyoClient(async (_url, init) => {
      const headers = new Headers(init.headers);
      expect(headers.get("x-rpc-device_id")).toBe("account-device-2");
      const cookie = headers.get("Cookie") ?? "";
      attempts.push(cookie);
      if (cookie === "cookie_token=old-profile") return Response.json({ retcode: -100 });
      return Response.json({ retcode: 0, data: { role_id: source.role.uid } });
    }, { profiles, async exchange(current) {
      recoveries++;
      expect(current.profileId).toBe(2);
      expect(current.revision).toBe(source.revision);
      return { ltoken: "replacement", cookie: "cookie_token=new-profile" };
    } });
    const result = await client.fetchStarRailChallenge(source, { kinds: ["hall"], period: "current", simple: false });
    expect(attempts).toEqual(["cookie_token=old-profile", "cookie_token=new-profile"]);
    expect(recoveries).toBe(1);
    expect(result.revision).toBe((await profiles.accountContext(qq, 2)).revision);
    expect((await profiles.accountContext(qq, 1)).account.cookie).toBe("cookie_token=other-profile");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
