import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { createHoyoClient, HoyoRequestError } from "@lotus-yunzai/hoyo-client";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { normalizeZzzHoloBoss, readZzzHoloBoss } from "../packages/hoyo-client/zzz-holo-boss.ts";

const uid = "12345678";
const region = "prod_qd_cn";
const identity = { uid, region, scheduleType: 1 } as const;
const fixture = {
  unlock: true, uid, region,
  start_time: { year: 2026, month: 11, day: 1, hour: 4 }, end_time: { year: 2026, month: 11, day: 16, hour: 4 },
  list: [
    { boss: { name: "合成首领一", medal: { is_no_injured: true } }, star: 4, rank: 123,
      challenge_time: { minute: 1, second: 10 }, avatar_list: [{ id: 1011, rarity: "A", rank: 2 }, null] },
    { boss: { name: "合成首领二" }, star: 0, rank: 0, challenge_time: { minute: 0, second: 0 }, avatar_list: [] },
  ],
};
const payload = (data: unknown) => Response.json({ retcode: 0, data });

test("拟境保持旧首领顺序、零星、用时、百分位、队伍和无伤", () => {
  const record = normalizeZzzHoloBoss(fixture, identity);
  expect(record).toMatchObject({
    status: "available", totalStars: 4, totalDuration: 70, undamaged: 1,
    period: { start: "2026-11-01 04:00:00", end: "2026-11-16 04:00:00" },
    bosses: [
      { name: "合成首领一", duration: 70, stars: 4, rank: 123, undamaged: true,
        avatars: [{ itemId: "1011", rarity: "A", rank: 2 }, undefined] },
      { name: "合成首领二", duration: 0, stars: 0, rank: undefined, undamaged: false, avatars: [] },
    ],
  });
  const partial = normalizeZzzHoloBoss({ unlock: true, list: [{ boss: { name: "合成新首领" }, challenge_time: {} }] }, identity);
  expect([partial.totalStars, partial.totalDuration, partial.period]).toEqual([undefined, undefined, undefined]);
  for (const empty of [{ unlock: false }, { unlock: true, list: [] }]) {
    expect(normalizeZzzHoloBoss(empty, identity)).toEqual({ ...identity, status: "empty", undamaged: 0, bosses: [] });
  }
});

test("拟境拒绝错绑定、错期和有害长度的格式", () => {
  for (const fields of [
    { uid: "23456789" }, { server: "prod_gf_cn" }, { game_biz: "nap_global" }, { schedule_type: 2 },
    { unlock: "true" }, { start_time: { ...fixture.start_time, day: 31 } },
    { start_time: fixture.end_time, end_time: fixture.start_time },
    { list: [null] }, { list: new Array(9).fill({}) }, { list: [{ star: 5 }] },
    { list: [{ challenge_time: { minute: 2, second: 60 } }] }, { list: [{ avatar_list: [null, null, null, null] }] },
    { list: [{ boss: { medal: { is_no_injured: "true" } } }] },
  ]) {
    expect(() => normalizeZzzHoloBoss({ ...fixture, ...fields }, identity)).toThrow(HoyoRequestError);
  }
});

test("拟境只按旧路径发同档设备及 Cookie，海外、非法期次和取消不发起请求", async () => {
  const source = {
    qq: "42", profileId: 2, game: "zzz", revision: "fixture-revision",
    account: { cookie: "ltoken=fixture-cookie" }, device: { id: "fixture-device", fp: "fixture-fp" },
    role: { uid, region, gameBiz: "nap_cn" },
  } as ProfileRequestContext;
  for (const scheduleType of [1, 2] as const) {
    let guarded = 0;
    const result = await readZzzHoloBoss(source, async (url, init) => {
      expect(url.href).toBe(`https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/holo_boss_detail?lang=zh-cn&uid=${uid}&region=${region}&schedule_type=${scheduleType}`);
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      const headers = new Headers(init.headers);
      expect(headers.get("Cookie")).toBe("ltoken=fixture-cookie");
      expect(headers.get("x-rpc-device_id")).toBe("fixture-device");
      expect(headers.get("x-rpc-device_fp")).toBe("fixture-fp");
      return payload({ ...fixture, schedule_type: scheduleType });
    }, { scheduleType }, async () => { guarded++; });
    expect(result.scheduleType).toBe(scheduleType);
    expect(guarded).toBe(2);
  }
  const never = async () => { throw new Error("合成验收不应发起该请求。"); };
  const overseas = { ...source, role: { ...source.role, uid: "1300000002", region: "prod_gf_jp", gameBiz: "nap_global" } };
  await expect(readZzzHoloBoss(overseas, never, { scheduleType: 1 })).rejects.toMatchObject({ code: "invalid-input" });
  await expect(readZzzHoloBoss(source, never, { scheduleType: 3 as 1 })).rejects.toMatchObject({ code: "invalid-input" });
  await expect(readZzzHoloBoss(source, never, { scheduleType: 1, signal: AbortSignal.abort() }))
    .rejects.toMatchObject({ code: "transport" });
});

test("拟境明确过期只重取同档一次，换绑、风控与限流不再发请求", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-zzz-holo-fixture-"));
  try {
    const path = join(dir, "42-2.yaml");
    const profile = (role: string, cookie: string) => [
      'user: { qq: "42" }', "profile: { id: 2 }", "account:",
      `  cookie: "cookie_token=${cookie}"`, '  stoken: "fixture-stoken"', '  stuid: "43"',
      `  game_roles: { zzz: [{ uid: "${role}", region: ${region}, game_biz: nap_cn }] }`,
      `  current_uid: { zzz: "${role}" }`,
    ].join("\n");
    await writeFile(path, profile(uid, "fixture-old"));
    const profiles = createProfileStore(dir);
    const before = await profiles.requestContext("42", 2, "zzz");
    const calls: string[] = [];
    let renewals = 0;
    let mode: "refresh" | "swap" | "risk" | "limit" = "refresh";
    const client = createHoyoClient(async (url, init) => {
      expect(url.searchParams.get("uid")).toBe(uid);
      const cookie = new Headers(init.headers).get("Cookie")!;
      calls.push(cookie);
      if (mode === "refresh" && cookie.endsWith("fixture-old")) return new Response(null, { status: 401 });
      if (mode === "risk") return new Response(null, { headers: { "x-rpc-aigis": "fixture-verify" } });
      if (mode === "limit") return new Response(null, { status: 429 });
      if (mode === "swap") await writeFile(path, profile("23456789", "fixture-other"));
      return payload(fixture);
    }, { profiles, async exchange(active) {
      expect([active.qq, active.profileId, active.revision]).toEqual(["42", 2, before.revision]);
      renewals++;
      return { cookie: "cookie_token=fixture-new", ltoken: "fixture-fresh" };
    } });
    const result = await client.fetchZzzHoloBoss(before, { scheduleType: 1 });
    const fresh = await profiles.requestContext("42", 2, "zzz");
    expect(result).toMatchObject({ uid, revision: fresh.revision, refreshedCookie: true });
    expect(calls).toEqual(["cookie_token=fixture-old", "cookie_token=fixture-new"]);
    for (const [next, expected] of [
      ["risk", { reason: "risk" }], ["limit", { reason: "rate-limited" }], ["swap", { code: "profile-changed" }],
    ] as const) {
      mode = next;
      const count = calls.length;
      await expect(client.fetchZzzHoloBoss(fresh, { scheduleType: 1 })).rejects.toMatchObject(expected);
      expect(calls.length).toBe(count + 1);
    }
    expect(renewals).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
