import { expect, test } from "bun:test";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { normalizeGameCommand } from "../lib/command-prefix.ts";
import { lockFile } from "../lib/file-lock.ts";
import type { MessageEvent } from "../lib/messages.ts";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import { readStarRailRogue } from "../packages/hoyo-client/starrail-rogue.ts";
import { createStarRailRogueQuery } from "../plugins/starrail/rogue-command.ts";
import { makeRogueCard, parseStarRailRogue } from "../plugins/starrail/rogue-model.ts";
import { createModule } from "../plugins/starrail/index.ts";

const source: ProfileRequestContext = {
  qq: "42", profileId: 2, revision: "fixture", game: "sr",
  role: { uid: "500000123", region: "prod_qd_cn", gameBiz: "hkrpg_cn", nickname: "合成开拓者", chosen: true },
  account: { cookie: "cookie_token=fixture", stoken: "", stuid: "", stokenCookie: "", ltuid: "", ltoken: "", mid: "" },
  device: { id: "fixture-device", fp: "fixture-fp", name: "", model: "Android", androidVersion: "13", raw: {} },
};
const context = { user_id: 42, self_id: 55, message_type: "private", privateCredentialSignal: new AbortController().signal };
const special = "https://act-webstatic.mihoyo.com/releases/test.png?signed=should-not-stay";
const current = {
  name: "迴响·终末",
  finish_time: { year: 2026, month: 3, day: 6, hour: 21, minute: 7, second: 3 },
  difficulty: 5, score: 14000, common_info_v2: { level: 10 },
  final_lineup: [{ id: 1001, level: 80, rank: 0, rarity: 5, icon: special }],
  fury: { type: 0, point: 4 }, worm_weak: ["火"], blocks: [{ name: "首领", num: 3 }],
  persona_style: { title: "巡游", desc: "<b>祝福加成</b><br>下一行", style_level: 3 },
  buffs: [{ base_type: { name: "巡猎" }, items: [{ name: "帝星临制", is_evoluted: true }] }],
  miracles: [{ name: "奇物一", rank: 3 }], hex_miracles: [{ name: "加权奇物一" }],
  formula_list: [{ name: "写信人", formula_category: "普通方程", sub_icon: special }],
  room_card_list: [{ type_name: "首领站点", icon_path: special, level: 3 }],
};
const older = { ...current, name: "旧版战报", difficulty: 2 };
const fixture = {
  role: { uid: 500000123, server: "prod_qd_cn", nickname: "开拓者", level: 70 },
  basic_info: { unlocked_skill_points: 12, unlocked_miracle_num: 14, unlocked_buff_num: 107 },
  current_record: { basic: { finish_cnt: 2, schedule_begin: current.finish_time, schedule_end: current.finish_time }, records: [current] },
  last_record: { records: [older] },
  basic: { cnt: { event: 42, miracle: 24, narrow: 13 }, destiny: [{ level: 3 }, { level: 5 }],
    season_level: 75, weekly_score: 1000, weekly_score_max: 5000, finished_weekly: false,
    season_task_finished: 5, season_task_total: 11, possibility_gallery_finished: 19, possibility_gallery_total: 42,
    normal_record_brief: { title: "灿烂", common_info_v2: { level: 12, exist_data: true } },
    weekly_record_brief: { common_info_v2: { id: 3 } },
  },
  detail: { records: [current] }, normal_detail: { records: [current, older] },
  cur_week_detail: { weekly_name: "今周buff", weekly_buff_desc: ["●每日必胜"], records: [current] },
  last_week_detail: { weekly_name: "上周buff", weekly_buff_desc: ["●<b>旧加成</b>"], records: [older] },
};
function command(message: string) {
  return parseStarRailRogue(normalizeGameCommand({ msg: message } as MessageEvent).msg)!;
}

test("保留模拟宇宙、蝗灾、差分和五种周期演算命令的档位、编号", () => {
  expect(command("*本期模拟宇宙").mode).toBe("universe");
  expect(command("*上期宇宙").period).toBe("previous");
  expect(command("*蝗灾 500000123").ownUid).toBe("500000123");
  expect(command("#星铁差分宇宙2")).toMatchObject({ mode: "tourn", profileId: 2 });
  expect(command("*常规差分宇宙回顾2 档案2")).toMatchObject({ mode: "normal", index: 2, profileId: 2 });
  expect(command("*本周演算战报2 500000123")).toMatchObject({ mode: "weekly", period: "current", index: 2, ownUid: "500000123" });
  expect(command("*上周差分记录")).toMatchObject({ mode: "weekly", period: "previous", index: 1 });
  expect(command("*周期演算").mode).toBe("weekly-help");
  expect(command("*黄金与机械")).toBeUndefined();
  expect(command("*不可知域")).toBeUndefined();
  expect(command("#模拟宇宙")).toBeUndefined();
});

test("国服三个原路由按原参数顺序签发，只送本档 Cookie 和设备", async () => {
  const prefix = "/game_record/app/hkrpg/api/";
  const query = "?need_detail=true&role_id=500000123";
  const server = "&server=prod_qd_cn";
  const contracts = [
    [{ kind: "starrail-rogue", scheduleType: 1 }, "rogue", "&schedule_type=1"],
    [{ kind: "starrail-rogue", scheduleType: 2 }, "rogue", "&schedule_type=2"],
    [{ kind: "starrail-rogue-locust" }, "rogue_locust", ""],
    [{ kind: "starrail-rogue-tourn" }, "rogue_tourn", ""],
  ] as const;
  for (const [options, path, period] of contracts) {
    let guards = 0;
    await expect(readStarRailRogue(source, async (url, init) => {
      const headers = new Headers(init.headers);
      expect(url.origin).toBe("https://api-takumi-record.mihoyo.com");
      expect(url.pathname).toBe(prefix + path);
      expect(url.search).toBe(query + period + server);
      expect(headers.get("Cookie")).toBe(source.account.cookie);
      expect(headers.get("x-rpc-device_id")).toBe(source.device.id);
      expect(headers.get("x-rpc-device_fp")).toBe(source.device.fp);
      expect([init.method, init.credentials, init.redirect]).toEqual(["GET", "omit", "error"]);
      return Response.json({ retcode: 0, data: fixture });
    }, options, async () => { guards++; })).resolves.toEqual({ data: fixture });
    expect(guards).toBe(2);
  }
});

test("拒绝跨角色、跨区、缺设备、结构错误及风险响应", async () => {
  const options = { kind: "starrail-rogue-tourn" } as const;
  for (const data of [{ role: { uid: "500000100" } }, { server: "prod_gf_cn" },
    { normal_detail: { records: [42] } }, { normal_detail: [] }, { role: "unknown" }]) {
    await expect(readStarRailRogue(source, async () => Response.json({ retcode: 0, data }), options))
      .rejects.toMatchObject({ code: "response" });
  }
  const offline = async () => { throw Error("不得联网"); };
  await expect(readStarRailRogue({ ...source, device: { ...source.device, fp: "" } }, offline, options))
    .rejects.toMatchObject({ code: "invalid-input" });
  await expect(readStarRailRogue({ ...source, role: { ...source.role, gameBiz: "hkrpg_global" } }, offline, options))
    .rejects.toMatchObject({ code: "invalid-input" });
  await expect(readStarRailRogue(source, async () => Response.json({ retcode: 0, data: {} }, {
    headers: { "x-rpc-aigis": '{"challenge":true}' },
  }), options)).rejects.toMatchObject({ reason: "risk" });
  await expect(readStarRailRogue(source, async () => Response.json({ retcode: 0, data: null }), options))
    .resolves.toEqual({ data: {} });
});

test("过期 Cookie 由共享档案换票，当次请求只复试一次", async () => {
  let active = source;
  const attempts: string[] = [];
  const refreshed = "cookie_token=renewer-fixture";
  const client = createHoyoClient(async (url, init) => {
    expect(url.pathname).toEndWith("/rogue_tourn");
    const cookie = new Headers(init.headers).get("Cookie")!;
    attempts.push(cookie);
    return cookie === refreshed ? Response.json({ retcode: 0, data: fixture }) : Response.json({ retcode: -100, data: null });
  }, {
    profiles: {
      async accountContext(qq, id) { expect([qq, id]).toEqual(["42", 2]); return active; },
      async saveRefreshedCredentials(qq, id, revision, credentials) {
        expect([qq, id, revision, credentials.cookie]).toEqual(["42", 2, source.revision, refreshed]);
        active = { ...active, revision: "renewed-fixture", account: { ...active.account, cookie: credentials.cookie } };
        return active;
      },
      async saveRoles() { throw Error("读取战绩不写角色"); },
    },
    async exchange(selected, opts) {
      expect([selected.qq, selected.profileId, selected.revision]).toEqual([source.qq, source.profileId, source.revision]);
      await opts?.verifyProfile?.();
      return { cookie: refreshed, ltoken: "" };
    },
  });
  await expect(client.fetchStarRailRogue(source, { kind: "starrail-rogue-tourn" }))
    .resolves.toMatchObject({ data: fixture, revision: "renewed-fixture", refreshedCookie: true });
  expect(attempts).toEqual([source.account.cookie, refreshed]);
});

test("模型按期次和档案记录选择，保留空值、强化祝福、装备和奖励数据", () => {
  const card = (value: string) => {
    const result = makeRogueCard(source.role.uid, fixture, command(value));
    if ("message" in result) throw Error(result.message);
    return result.card;
  };
  expect(card("*模拟宇宙").intro).toEqual(["统计周期 2026.03.06 — 2026.03.06"]);
  expect(card("*上期宇宙").records[0]?.name).toBe("旧版战报 1 / 1");
  expect(card("*寰宇蝗灾").destiny).toMatchObject([{ name: "存护", detail: "3" }, { name: "记忆", detail: "5" }]);
  expect(card("*寰宇蝗灾").records[0]?.summary).toContain("位面紊乱倒计时 4");
  expect(card("*差分宇宙").stats.find(item => item.name === "可能性画廊奖励")?.detail).toBe("19 / 42");
  expect(card("*常规演算2").records[0]?.sections.map(section => section.name)).toEqual([
    "探索队伍", "面具", "加权奇物", "已展开方程", "获得祝福 · 1", "获得奇物", "沿途站点",
  ]);
  expect(card("*本期演算").records[0]?.sections[0]?.tiles?.[0]?.detail).toContain("星魂 0");
  expect(card("*本期演算").records[0]?.sections[0]?.tiles?.[0]?.icon).toBe("https://act-webstatic.mihoyo.com/releases/test.png");
  expect(card("*上周演算").intro).toEqual(["上周buff", "旧加成"]);
  expect(makeRogueCard(source.role.uid, fixture, command("*上周演算3"))).toEqual({
    message: "未找到差分宇宙 · 上期周期演算第 3 条记录，共 1 条。",
  });
  expect(makeRogueCard(source.role.uid, {}, command("*本期演算"))).toEqual({
    message: "未找到差分宇宙 · 本期周期演算第 1 条记录，共 0 条。",
  });
});

test("本人受信私聊才读取，回包或出图期间换档即撤回结果", async () => {
  let calls = 0, renders = 0;
  let active = source;
  const request = command("*本期演算 档案2");
  const query = createStarRailRogueQuery({
    async requestSelectedContext(qq, id) { expect([qq, id]).toEqual(["42", 2]); return active; },
  }, {
    async fetchStarRailRogue(selected, options) {
      expect(selected).toBe(source);
      expect(options.kind).toBe("starrail-rogue-tourn");
      calls++;
      return { data: fixture, revision: source.revision, refreshedCookie: false };
    },
  }, new AbortController().signal, async () => {
    renders++;
    if (renders === 2) active = { ...source, revision: "new" };
    return { png: new Uint8Array([1, 2, 3]) };
  });
  const abort = AbortSignal.abort();
  for (const event of [{ ...context, message_type: "group" }, { ...context, isDelegated: true },
    { ...context, privateCredentialSignal: undefined }, { ...context, at: 777 }]) {
    expect(await query(event, request)).toBe("宇宙战绩只查询本人已绑定档案，请在机器人好友私聊使用。");
  }
  expect(await query({ ...context, privateCredentialSignal: abort }, request)).toEqual([]);
  expect(await query(context, { ...request, ownUid: "500000887" })).toBe("查询 UID 须与当前本人档案一致，请使用对应的档案编号。");
  expect(calls).toBe(0);
  expect(await query(context, request)).toEqual({ type: "image", file: new Uint8Array([1, 2, 3]) });
  expect(await query(context, request)).toBe("星铁档案已变更，请重新查询宇宙战绩。");
  expect(calls).toBe(2);
});

test("固定星铁模块把宇宙命令分派到新入口与正确的关闭标签", async () => {
  const module = createModule({ signal: new AbortController().signal, lockFile });
  const normalizedMessage = "#星铁上周演算战绩3 档案2";
  const message = { normalizedMessage, user_id: 42, self_id: 55, message_type: "group", reply() {} };
  expect(await module.fallbackFeatures(message)).toEqual(["[starrail] 宇宙战绩"]);
  expect(await module.fallback(normalizedMessage, message)).toMatch(/机器人好友私聊/u);
  const help = "#星铁周期差分宇宙";
  expect(await module.fallback(help, { ...message, normalizedMessage: help })).toMatch(/\*本期演算.*\*上期演算/u);
});
