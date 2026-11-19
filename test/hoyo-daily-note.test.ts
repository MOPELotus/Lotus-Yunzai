import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, type ProfileRequestContext } from "../packages/account/index.ts";
import type { HoyoTransport } from "../packages/hoyo-client/credentials.ts";
import { isDailyNoteCookieExpired, readDailyNote } from "../packages/hoyo-client/daily-note.ts";
import { HoyoRequestError } from "../packages/hoyo-client/errors.ts";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";

const source = {
  qq: "42", profileId: 2, game: "gs", revision: "synthetic-revision",
  role: { uid: "123456789", region: "cn_gf01", gameBiz: "hk4e_cn", chosen: true, nickname: "模拟旅行者" },
  account: { cookie: "ltoken=synthetic-profile-cookie;", stoken: "unused-credential" },
  device: { id: "test-selected-device", fp: "test-selected-fingerprint", model: "Fixture", androidVersion: "13" },
} as ProfileRequestContext;

const starRail: ProfileRequestContext = {
  ...source, game: "sr", role: { ...source.role, uid: "523456789", region: "prod_qd_cn", gameBiz: "hkrpg_cn" },
};
const zzz: ProfileRequestContext = {
  ...source, game: "zzz", role: { ...source.role, uid: "12345678", region: "prod_gf_cn", gameBiz: "nap_cn" },
};

const gsResponse = {
  current_resin: 0, max_resin: "200", resin_recovery_time: "96000",
  current_home_coin: "2400", max_home_coin: 2400, home_coin_recovery_time: "0",
  is_extra_task_reward_received: false, current_expedition_num: "2", max_expedition_num: 5,
  expeditions: [{ status: "Ongoing", remained_time: "31503" }, { status: "Finished", remained_time: "0" }],
  remain_resin_discount_num: 1, resin_discount_num_limit: 3,
  transformer: { obtained: true, recovery_time: { reached: false, Day: "1", Hour: 2, Minute: 3, Second: 4 } },
};

test("国服三款官方体力 GET 采用固定接口、已选 UID、原档案设备和签名 query", async () => {
  const games = [
    [source, "/game_record/app/genshin/api/dailyNote", gsResponse],
    [starRail, "/game_record/app/hkrpg/api/note", { current_stamina: 240, max_stamina: "240" }],
    [zzz, "/event/game_record_zzz/api/zzz/note", { energy: { progress: { current: 10, max: 240 } } }],
  ] as const;
  for (const [context, path, data] of games) {
    const transport: HoyoTransport = async (endpoint, init) => {
      const { uid, region } = context.role;
      expect(endpoint.href).toBe(`https://api-takumi-record.mihoyo.com${path}?role_id=${uid}&server=${region}`);
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
      expect(init.body).toBeUndefined();
      const headers = new Headers(init.headers);
      expect(headers.get("cookie")).toBe(context.account.cookie);
      expect(headers.get("cookie")).not.toContain(context.account.stoken);
      expect(headers.get("x-rpc-device_id")).toBe(context.device.id);
      expect(headers.get("x-rpc-device_fp")).toBe(context.device.fp);
      expect(headers.get("x-rpc-app_version")).toBe("2.40.1");
      expect(headers.get("x-rpc-client_type")).toBe("5");
      expect(headers.get("referer")).toBe("https://webstatic.mihoyo.com/");
      const [t, r, digest] = headers.get("DS")!.split(",");
      const expected = createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${t}&r=${r}&b=&q=${endpoint.search.slice(1)}`).digest("hex");
      expect(digest).toBe(expected);
      return Response.json({ retcode: 0, data: { ...data, role_id: uid, server: region } });
    };
    expect(await readDailyNote(context, transport)).toMatchObject({
      game: context.game, uid: context.role.uid, region: context.role.region,
    });
  }
});

test("归一化三款已知值，包括零、无恢复时间、备用开拓力和旧版刮刮卡状态", async () => {
  const respond = (data: unknown): HoyoTransport => async () => Response.json({ retcode: 0, data });
  expect(await readDailyNote(source, respond(gsResponse))).toMatchObject({
    stamina: { current: 0, max: 200, recoverySeconds: 96000 },
    homeCoin: { current: 2400, max: 2400, recoverySeconds: 0 }, commissionRewardReceived: false,
    expeditions: { current: 2, max: 5, remainingSeconds: 0 },
    weeklyDiscount: { current: 2, max: 3 }, transformer: { ready: false, remainingSeconds: 93784 },
  });
  expect(await readDailyNote(starRail, respond({
    current_stamina: 260, max_stamina: "240", accepted_epedition_num: 0, total_expedition_num: 4,
    current_train_score: "0", max_train_score: 500, current_reserve_stamina: 0,
    current_rogue_score: 0, max_rogue_score: 0, weekly_cocoon_cnt: 2, weekly_cocoon_limit: 3,
  }))).toMatchObject({
    stamina: { current: 260, max: 240 }, expeditions: { current: 0, max: 4 },
    reserveStamina: 0, training: { current: 0, max: 500 }, rogue: { current: 0, max: 0 }, echoOfWar: { current: 2, max: 3 },
  });
  const model = await readDailyNote(zzz, respond({
    energy: { progress: { current: 12, max: "240" } }, vhs_sale: { sale_state: "SaleStateDoing" },
    vitality: { current: 0, max: 400 }, card_sign: "CardSignDone",
  }));
  expect(model).toMatchObject({ stamina: { current: 12, max: 240 },
    vitality: { current: 0, max: 400 }, videoStore: "doing", scratchCardDone: true });
  expect(model.stamina).not.toHaveProperty("recoverySeconds");
  expect(await readDailyNote(zzz, respond({ energy: { current: 0, max: 240, restore: 0 }, card_sign: { status: false } })))
    .toMatchObject({ scratchCardDone: false, stamina: { current: 0, max: 240, recoverySeconds: 0 } });
});

test("海外、区服不明确、游戏不匹配及不安全 Cookie 都不会调用传输", async () => {
  const noSend: HoyoTransport = async () => { throw new Error("unexpected transport"); };
  for (const [context, changes] of [
    [source, { uid: "423456789", region: "" }], [source, { region: "os_usa" }], [source, { uid: "623456789" }],
    [source, { uid: "523456789" }], [source, { gameBiz: "hkrpg_cn" }],
    [starRail, { uid: "1823456789", region: "prod_official_asia" }],
    [zzz, { uid: "1300000002" }],
  ] as const) {
    await expect(readDailyNote({ ...context, role: { ...context.role, ...changes } }, noSend))
      .rejects.toMatchObject({ code: "invalid-input" });
  }
  await expect(readDailyNote({ ...source, account: { ...source.account, cookie: "ltoken=test\r\n" } }, noSend))
    .rejects.toMatchObject({ code: "invalid-input" });
});

test("旧档只保存国服 UID 时按已知 UID 区间恢复区服", async () => {
  for (const context of [source, starRail, zzz]) {
    const data = context.game === "gs" ? gsResponse : context.game === "sr"
      ? { current_stamina: 10, max_stamina: 240 } : { energy: { current: 10, max: 240 } };
    const response = await readDailyNote({ ...context, role: { ...context.role, region: "", gameBiz: "" } },
      async (endpoint) => {
        expect(endpoint.searchParams.get("server")).toBe(context.role.region);
        return Response.json({ retcode: 0, data });
      });
    expect(response.region).toBe(context.role.region);
  }
});

test("登录失效、风控与限频分开处理且上游正文不会进入错误提示", async () => {
  for (const [status, retcode, message, reason] of [
    [200, -100, "stale synthetic-secret", "expired"],
    [200, 10035, "synthetic-secret", "risk"],
    [200, 10041, "synthetic-secret", "risk"],
    [200, -100, "captcha synthetic-secret", "risk"],
    [200, -100, "visit too frequently synthetic-secret", "rate-limited"],
    [401, 1034, "synthetic-secret", "risk"],
    [401, -100, "synthetic-secret", "expired"],
    [429, 0, "synthetic-secret", "rate-limited"],
  ] as const) {
    let calls = 0;
    const error = await readDailyNote(source, async () => {
      calls++;
      return Response.json({ retcode, message }, { status });
    }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ reason, status });
    expect(isDailyNoteCookieExpired(error)).toBe(reason === "expired");
    expect(String(error)).not.toContain("synthetic-secret");
    expect(calls).toBe(1);
  }
});

test("档案换绑、取消、错误响应身份及过大数据都会丢弃结果", async () => {
  const changed = new HoyoRequestError("profile-changed", "档案已变更");
  let calls = 0;
  let checks = 0;
  const transport: HoyoTransport = async () => {
    calls++;
    return Response.json({ retcode: 0, data: gsResponse });
  };
  await expect(readDailyNote(source, transport, {}, async () => { throw changed; })).rejects.toBe(changed);
  expect(calls).toBe(0);
  await expect(readDailyNote(source, transport, {}, async () => {
    if (++checks === 2) throw changed;
  })).rejects.toBe(changed);
  expect(calls).toBe(1);
  const abort = new AbortController();
  await expect(readDailyNote(source, async () => {
    abort.abort(new Error("private cancellation reason"));
    return Response.json({ retcode: 0, data: gsResponse });
  }, { signal: abort.signal })).rejects.toThrow("查询已取消");
  for (const changes of [{ role_id: "223456789" }, { server: "cn_qd01" }, { game_biz: "hkrpg_cn" },
    { max_resin: "200 bad" }]) {
    await expect(readDailyNote(source, async () => Response.json({ retcode: 0, data: { ...gsResponse, ...changes } })))
      .rejects.toMatchObject({ code: "response" });
  }
  await expect(readDailyNote(source, async () => new Response("a".repeat(65 * 1024))))
    .rejects.toMatchObject({ code: "response" });
});

test("一个档案只续期一次，某角色重试失败后其余角色用已续期的同档凭据", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-daily-note-client-"));
  const path = join(directory, "42-2.yaml");
  const profile = `profile: { id: 2 }
user: { qq: 42 }
account:
  cookie: ltoken=old
  stoken: fixture-stoken
  game_roles:
    gs: [{ uid: '123456789', region: cn_gf01 }, { uid: '223456789', region: cn_gf01 }]
    sr: [{ uid: '523456789', region: prod_qd_cn }]
device: { id: fixture-device }
`;
  try {
    await writeFile(path, profile);
    const profiles = createProfileStore(directory);
    const sources = await profiles.requestContexts("42", 2);
    const calls: string[][] = [];
    let exchanges = 0;
    const client = createHoyoClient(async (endpoint, options) => {
      const uid = endpoint.searchParams.get("role_id")!;
      const cookie = new Headers(options.headers).get("cookie")!;
      calls.push([uid, cookie]);
      if (cookie === "ltoken=old" || uid === "223456789") return Response.json({ retcode: -100 });
      if (uid === "123456789") return Response.json({ retcode: 1034 });
      return Response.json({ retcode: 0, data: { current_stamina: 0, max_stamina: 300 } });
    }, {
      profiles,
      async exchange(context) {
        exchanges++;
        expect(context.account.stoken).toBe("fixture-stoken");
        expect(context.device.id).toBe("fixture-device");
        return { cookie: "ltoken=renewed", ltoken: "renewed" };
      },
    });
    await expect(client.fetchDailyNotes([sources[0]!, { ...sources[1]!, profileId: 3 }])).rejects.toMatchObject({ code: "invalid-input" });
    expect(calls).toEqual([]);
    expect(await client.fetchDailyNotes(sources)).toMatchObject([
      { status: "rejected", reason: { reason: "risk" } },
      { status: "rejected", reason: { reason: "expired" } },
      { status: "fulfilled", value: { game: "sr", uid: "523456789", stamina: { current: 0, max: 300 } } },
    ]);
    expect(calls).toEqual([
      ["123456789", "ltoken=old"], ["123456789", "ltoken=renewed"],
      ["223456789", "ltoken=renewed"], ["523456789", "ltoken=renewed"],
    ]);
    expect(exchanges).toBe(1);

    const latest = await profiles.requestContexts("42", 2);
    const rebound = createHoyoClient(async () => {
      await writeFile(path, profile.replace("fixture-stoken", "new-stoken"));
      return Response.json({ retcode: 0, data: gsResponse });
    }, { profiles, async exchange() { throw new Error("unexpected refresh"); } });
    await expect(rebound.fetchDailyNotes(latest)).rejects.toMatchObject({ code: "profile-changed" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
