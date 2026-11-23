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
import { dailyNoteCommands } from "../lib/daily-note.ts";
import { CommandRegistry } from "../lib/commands.ts";
import { normalizeGameCommand } from "../lib/command-prefix.ts";
import type { MessageEvent } from "../lib/messages.ts";

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

test("体力查询续期后发出首页，换绑时停止发送余下页面", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-daily-note-delivery-"));
  const profiles = createProfileStore(directory);
  const originalFetch = globalThis.fetch;
  const roles = Array.from({ length: 7 }, (_, index) => ({
    uid: `12345678${index}`, region: "cn_gf01", game_biz: "hk4e_cn",
  }));
  let exchanges = 0;
  let pages = 0;
  try {
    await writeFile(join(directory, "42.yaml"), JSON.stringify({
      account: { stuid: "62", stoken: "fixture-stoken", cookie: "ltoken=expired", game_roles: { gs: roles } },
      device: { id: "fixture-device" },
    }));
    globalThis.fetch = (async (input, options) => {
      const endpoint = new URL(String(input));
      const cookie = new Headers(options?.headers).get("cookie");
      const ok = (data: unknown) => Response.json({ retcode: 0, data });
      if (endpoint.pathname.endsWith("getLTokenBySToken")) {
        exchanges++;
        return ok({ ltoken: "fixture-fresh" });
      }
      if (endpoint.pathname.endsWith("getCookieAccountInfoBySToken")) {
        exchanges++;
        return ok({ uid: "62", cookie_token: "fixture-cookie" });
      }
      if (endpoint.pathname.endsWith("getUserGameRolesByCookie")) {
        return ok({ list: roles.map(role => ({ ...role, game_uid: role.uid })) });
      }
      expect(endpoint.pathname).toEndWith("/dailyNote");
      return cookie === "ltoken=expired" ? Response.json({ retcode: -100 }) : ok(gsResponse);
    }) as typeof fetch;
    const run = dailyNoteCommands(directory, new AbortController().signal).fallback!;
    const reply = await run("", {
      user_id: 42, self_id: 51, message_type: "group", group_id: 100,
      isMaster: false, isBotMaster: () => false, normalizedMessage: "#体力",
      async reply(message) {
        if (typeof message === "string" && message.includes("正在查询")) return true;
        pages++;
        if (pages === 1) await profiles.clearLogin("42");
        return true;
      },
    });
    expect(exchanges).toBe(2);
    expect(pages).toBe(1);
    expect(reply).toContain("登录状态已变化");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

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

const overseasNote = {
  cookie: "ltuid_v2=42; ltoken_v2=fixture-token; ltmid_v2=fixture-mid", accountId: "42", realm: "SG" as const,
  language: "zh-cn", selectedUid: "1300000002", revision: "test-overseas-note",
};
const overseasNoteRole = { game_uid: "1300000002", region: "prod_gf_jp", game_biz: "nap_global" };
const zzzEnergy = { progress: { current: 0, max: "240" }, restore: 14_400 };

test("国际服绝区零便笺从 HoYoLAB 确认角色后按旧 GET 读取完整状态", async () => {
  let calls = 0;
  let guards = 0;
  const client = createHoyoClient(async (url, init) => {
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(new Headers(init.headers).get("cookie")).toBe(overseasNote.cookie);
    if (calls++ === 0) {
      expect(url.href).toBe("https://api-account-os.hoyolab.com/binding/api/getUserGameRolesByLtoken?game_biz=nap_global");
      return Response.json({ retcode: 0, data: { list: [overseasNoteRole] } });
    }
    expect(url.href).toBe("https://sg-act-public-api.hoyolab.com/event/game_record_zzz/api/zzz/note?role_id=1300000002&server=prod_gf_jp");
    return Response.json({ retcode: 0, data: { ...overseasNoteRole, energy: zzzEnergy,
      vitality: { current: 0, max: 400 }, vhs_sale: { sale_state: "SaleStateDoing" }, card_sign: "CardSignDone" } });
  });
  expect(await client.fetchHoYoLabZzzDailyNote(overseasNote, { async verifyProfile() { guards++; } })).toMatchObject({
    game: "zzz", uid: overseasNote.selectedUid, region: "prod_gf_jp", stamina: { current: 0, max: 240, recoverySeconds: 14_400 },
    vitality: { current: 0, max: 400 }, videoStore: "doing", scratchCardDone: true,
  });
  expect([calls, guards]).toEqual([2, 4]);
});

test("国际服便笺丢弃错角色、过期和查询期间换绑的结果", async () => {
  for (const [response, error] of [
    [{ retcode: 0, data: { role: { ...overseasNoteRole, region: "prod_gf_us" }, energy: zzzEnergy } }, { code: "response" }],
    [{ retcode: -100 }, { reason: "expired" }],
    [{ retcode: 1034 }, { reason: "risk" }],
  ] as const) {
    let calls = 0;
    const client = createHoyoClient(async () => Response.json(calls++ === 0
      ? { retcode: 0, data: { list: [overseasNoteRole] } } : response));
    await expect(client.fetchHoYoLabZzzDailyNote(overseasNote, { async verifyProfile() {} })).rejects.toMatchObject(error);
    expect(calls).toBe(2);
  }
  let guards = 0;
  const client = createHoyoClient(async () => Response.json({ retcode: 0, data: { list: [overseasNoteRole], energy: zzzEnergy } }));
  await expect(client.fetchHoYoLabZzzDailyNote(overseasNote, {
    async verifyProfile() {
      if (++guards === 4) throw new HoyoRequestError("profile-changed", "合成档案切换");
    },
  })).rejects.toMatchObject({ code: "profile-changed" });
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

test("已保存的旧 Cookie 档案只读体力，失效不会交换凭据，冲突账号不会出站", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-daily-note-legacy-cookie-"));
  const path = join(directory, "42-2.yaml");
  const profile = `profile: { id: 2 }
user: { qq: 42 }
account:
  cookie: "ltoken_v2=synthetic-ltoken;ltuid_v2=62;ltmid_v2=synthetic-mid;cookie_token_v2=synthetic-cookie;account_id_v2=62;account_mid_v2=synthetic-mid"
  ltuid: 62
  game_roles: { gs: [{ uid: '123456789', region: cn_gf01 }] }
`;
  try {
    await writeFile(path, profile);
    const profiles = createProfileStore(directory);
    await expect(profiles.requestContext("42", 2, "gs")).rejects.toMatchObject({ code: "login-required" });
    expect((await profiles.summary("42", 2)).loggedIn).toBe(false);
    const { sources, verifyReadOnly } = await profiles.requestContextsForRead("42", 2, ["gs"]);
    expect(sources[0]?.role.uid).toBe("123456789");
    expect(verifyReadOnly).toBeFunction();
    let requests = 0;
    let exchanges = 0;
    const client = createHoyoClient(async (endpoint, init) => {
      requests++;
      expect(endpoint.origin).toBe("https://api-takumi-record.mihoyo.com");
      expect(new Headers(init.headers).get("cookie")).toInclude("cookie_token_v2=synthetic-cookie");
      return Response.json({ retcode: -100 });
    }, { profiles, async exchange() { exchanges++; throw new Error("unexpected refresh"); } });
    expect(await client.fetchDailyNotes(sources, { verifyReadOnly })).toMatchObject([
      { status: "rejected", reason: { message: "旧 Cookie 已失效，无法自动续期，请扫码登录。" } },
    ]);
    expect([requests, exchanges]).toEqual([1, 0]);
    expect(await Bun.file(path).text()).toBe(profile);
    await writeFile(path, profile.replace("account_id_v2=62", "account_id_v2=63"));
    await expect(profiles.requestContextsForRead("42", 2, ["gs"])).rejects.toMatchObject({ code: "login-required" });
    await expect(client.fetchDailyNotes(sources, { verifyReadOnly })).rejects.toMatchObject({ code: "changed" });
    expect([requests, exchanges]).toEqual([1, 0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("星铁和绝区零旧体力别名经宿主前缀只读发起人的相应游戏档案", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-daily-note-alias-"));
  const originalFetch = globalThis.fetch;
  const profile = join(directory, "42-2.yaml");
  const gs = { uid: "123456789", region: "cn_gf01", game_biz: "hk4e_cn" };
  const sr = { uid: "523456789", region: "prod_qd_cn", game_biz: "hkrpg_cn" };
  const nap = { uid: "12345678", region: "prod_gf_cn", game_biz: "nap_cn" };
  const roles = [gs, sr, nap];
  const data = {
    profile: { id: 2 }, user: { qq: 42 },
    account: { stuid: "62", stoken: "synthetic-stoken", cookie: "ltoken=expired",
      game_roles: { gs: [gs], sr: [sr], zzz: [nap] } },
    device: { id: "synthetic-device" },
  };
  const queries: string[][] = [];
  const destinations: string[][] = [];
  let exchanges = 0;
  const registry = new CommandRegistry();

  const replies: unknown[] = [];
  const base: MessageEvent = {
    post_type: "message", msg: "", message: "", raw_message: "", message_type: "group",
    isGroup: true, isPrivate: false, isMaster: false, self_id: 51, user_id: 42, group_id: 99,
    async reply(message) { replies.push(message); return true; },
  };
  const group = { ...base };
  const privateFriend = { ...base, message_type: "private", isGroup: false, isPrivate: true, group_id: undefined,
    privateCredentialSignal: new AbortController().signal } as const;
  const dispatch = (msg: string, context = group) => registry.dispatchFallback(
    normalizeGameCommand({ ...context, msg, raw_message: msg, message: msg }), () => true, () => false,
  );
  try {
    globalThis.fetch = (async (input, options) => {
      const url = new URL(String(input)), path = url.pathname;
      const ok = (response: unknown) => Response.json({ retcode: 0, data: response });
      if (path.endsWith("/getLTokenBySToken")) {
        exchanges++;
        return ok({ ltoken: "synthetic-fresh" });
      }
      if (path.endsWith("/getCookieAccountInfoBySToken")) {
        exchanges++;
        return ok({ uid: "62", cookie_token: "synthetic-cookie" });
      }
      if (path.endsWith("/getUserGameRolesByCookie")) return ok({ list: roles.map(role => ({ ...role, game_uid: role.uid })) });
      const headers = new Headers(options?.headers);
      const cookie = headers.get("cookie") ?? "";
      destinations.push([url.origin, path, headers.get("x-rpc-device_id") ?? ""]);
      const game = path.endsWith("/hkrpg/api/note") ? "sr" : path.endsWith("/zzz/note") ? "zzz" : "unexpected";
      expect(["sr", "zzz"]).toContain(game);
      queries.push([game, url.searchParams.get("role_id")!, cookie.includes("synthetic-fresh") ? "fresh" : cookie]);
      if (cookie === "ltoken=expired") return Response.json({ retcode: -100 });
      return game === "sr" ? ok({ current_stamina: 120, max_stamina: 240 }) : ok({ energy: { progress: { current: 100, max: 240 } } });
    }) as typeof fetch;
    registry.registerModule(dailyNoteCommands(directory, new AbortController().signal));
    registry.registerModule({ name: "fixture-role-query", commands: {}, fallback: (_message, context) =>
      context.normalizedMessage === "#星铁三月七面板" || context.normalizedMessage === "#绝区零艾莲面板" ? "角色入口" : undefined });
    for (const [game, role, trigger, aliases] of [
      ["sr", sr, "*树脂", ["*查询体力", "#星铁树脂", "星铁查询体力", "##星铁查询体力", "*树脂2"]],
      ["zzz", nap, "%树脂", ["%查询体力", "#绝区树脂", "#绝区零查询体力", "##绝区查询体力", "％树脂2"]],
    ] as const) {
      await writeFile(profile, JSON.stringify(data));
      queries.length = destinations.length = 0;
      exchanges = 0;
      expect(await dispatch(trigger)).toEqual([]);
      expect(destinations).toEqual(Array.from({ length: 2 }, () => ["https://api-takumi-record.mihoyo.com",
        game === "sr" ? "/game_record/app/hkrpg/api/note" : "/event/game_record_zzz/api/zzz/note", "synthetic-device"]));
      expect(queries).toEqual([[game, role.uid, "ltoken=expired"], [game, role.uid, "fresh"]]);
      expect(exchanges).toBe(2);
      queries.length = 0;
      for (const alias of aliases) expect(await dispatch(alias, privateFriend)).toEqual([]);
      expect(queries).toEqual(aliases.map(() => [game, role.uid, "fresh"]));
      expect(exchanges).toBe(2);
    }
    queries.length = 0;
    expect(await dispatch("%查询体力", { ...group, user_id: 43, isMaster: true })).toContain("没有找到可查询的 profile");
    expect(await dispatch("*三月七面板")).toBe("角色入口");
    expect(await dispatch("%艾莲面板")).toBe("角色入口");
    expect(await dispatch("*树脂活动")).toBeUndefined();
    expect(await dispatch("%查询体力测试")).toBeUndefined();
    expect(queries).toEqual([]);
    expect(replies.some(reply => typeof reply === "string" && reply.includes("profile 2"))).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
