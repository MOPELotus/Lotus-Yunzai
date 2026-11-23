import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProfileRequestContext } from "@lotus-yunzai/account";
import { createHoyoClient } from "../packages/hoyo-client/index.ts";
import { readStarRailGrowth } from "../packages/hoyo-client/starrail-growth.ts";
import { normalizeGameCommand } from "../lib/command-prefix.ts";
import type { MessageEvent } from "../lib/messages.ts";
import { lockFile } from "../lib/file-lock.ts";
import { createStarRailGrowthQuery, matchStarRailGrowth } from "../plugins/starrail/growth/command.ts";
import { createModule } from "../plugins/starrail/index.ts";

const source: ProfileRequestContext = {
  qq: "42", profileId: 2, revision: "growth-fixture", game: "sr",
  role: { uid: "500000123", region: "prod_qd_cn", gameBiz: "hkrpg_cn", nickname: "fixture", chosen: true },
  account: { cookie: "cookie_token=test-cookie", stoken: "", stuid: "", stokenCookie: "", ltuid: "", ltoken: "", mid: "" },
  device: { id: "growth-device", fp: "growth-fp", name: "fixture", model: "Android", androidVersion: "13", raw: {} },
};
const { uid, region } = source.role;
const query = { avatarId: 1107, name: "克拉拉", levels: [75, 80, 6, 9, 9, 9] };
const preview = (name: string) => `https://act-webstatic.mihoyo.com/${name}.png?test=strip`;
const detail = {
  avatar: { item_id: "1107", item_name: "克拉拉", cur_level: 1, rarity: "5", icon_url: preview("clara") },
  skills: [1, 2, 3, 4].map((index) => ({ anchor: `Point0${index}`, point_id: String(1107000 + index), max_level: index === 1 ? 6 : 10,
    target_level: index === 1 ? 6 : 10, cur_level: 1, item_url: preview(`skill${index}`) })).reverse(),
  skills_other: [{ point_id: "1107111", cur_level: 0, max_level: 1, target_level: 1 }],
};
const avatar = { id: 1107, name: "克拉拉", level: 80, rank: 1, rarity: 5, icon: preview("owned"),
  equip: { id: 23002, name: "无可取代的东西", level: 60, rarity: 5, icon: preview("cone") } };
const results = { coin_id: "2", avatar_consume: [{ item_name: "信用点", num: 724000, item_url: preview("credits") }],
  skill_consume: [{ item_name: "「毁灭」相关材料", num: "20", item_url: preview("material") }], equipment_consume: [],
  user_owns_materials: [{ item_name: "不可显示的库存", num: 1 }] };
const envelope = (data: unknown) => Response.json({ retcode: 0, data });
const signal = new AbortController().signal;
const context = { user_id: 42, self_id: 88, message_type: "private", privateCredentialSignal: signal };

function parse(message: string) {
  return matchStarRailGrowth(normalizeGameCommand({ msg: message } as MessageEvent).msg);
}

test("识别旧克拉拉示例、三种分隔符、顺序目标、缺省、档号及帮助", () => {
  expect(parse("*克拉拉养成75 80 6 9 9 9")).toEqual({ mode: "calculate", name: "克拉拉", profileId: 1, levels: query.levels });
  expect(parse("#星铁克拉拉计算90，81,6 9 档案2")).toMatchObject({ levels: [80, 80, 6, 9, 10, 10], profileId: 2 });
  expect(parse("＊克拉拉养成")).toMatchObject({ levels: [80, 80, 6, 10, 10, 10] });
  expect(parse("*角色养成计算")).toEqual({ mode: "help" });
  expect(parse("*克拉拉养成1 2 3 4 5 6 7")).toEqual({ mode: "invalid" });
  expect(parse("*克拉拉养成0")).toEqual({ mode: "invalid" });
  expect(parse("*克拉拉养成档案256")).toEqual({ mode: "invalid" });
  expect(parse("#克拉拉养成")).toBeUndefined();
});

test("未拥有走 TabAll，固定国服 URL、签名及级别；选择技能槽不受回复排序影响", async () => {
  let checks = 0;
  const seen: string[] = [];
  const result = await readStarRailGrowth(source, async (url, init) => {
    seen.push(url.pathname);
    const headers = new Headers(init.headers);
    expect(headers.get("Cookie")).toBe(source.account.cookie);
    expect(headers.get("x-rpc-device_fp")).toBe(source.device.fp);
    expect(init.redirect).toBe("error");
    if (url.pathname.endsWith("/avatar/info")) return envelope({ role: { uid, region }, avatar_list: [] });
    expect(url.origin).toBe("https://api-takumi.mihoyo.com");
    const [time, nonce, digest] = headers.get("DS")!.split(",");
    expect(digest).toBe(createHash("md5").update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${time}&r=${nonce}&b=${init.body ?? ""}&q=${url.search.slice(1)}`).digest("hex"));
    if (url.pathname.endsWith("/avatar/detail")) {
      expect(url.search).toBe("?game=hkrpg&lang=zh-cn&item_id=1107&tab_from=TabAll&change_target_level=0&uid=500000123&region=prod_qd_cn");
      expect(init.method).toBe("GET");
      return envelope({ ...detail, is_login: false });
    }
    expect([init.method, url.search]).toEqual(["POST", "?game=hkrpg"]);
    const body = JSON.parse(String(init.body));
    expect(body.game).toBe("hkrpg");
    expect(body.avatar).toEqual({ item_id: 1107, cur_level: 1, target_level: 75 });
    expect(body.skill_list).toEqual([4, 3, 2, 1].map(index => ({ item_id: 1107000 + index, cur_level: 1,
      target_level: index === 1 ? 6 : 9 })));
    expect(body.equipment).toBeUndefined();
    return envelope(results);
  }, query, async () => { checks++; });
  expect(seen).toEqual(["/game_record/app/hkrpg/api/avatar/info", "/event/rpgcalc/avatar/detail", "/event/rpgcalc/compute"]);
  expect(checks).toBe(6);
  expect(result).toMatchObject({ owned: false, uid, avatar: { name: "克拉拉", current: 1, target: 75, rarity: 5,
    icon: "https://act-webstatic.mihoyo.com/clara.png" }, skills: [
    { name: "普通攻击", target: 6 }, { name: "战技", target: 9 }, { name: "终结技", target: 9 }, { name: "天赋", target: 9 },
  ], materials: { avatar_consume: [{ name: "信用点", total: 724000 }], skill_consume: [{ total: 20 }] } });
  expect(JSON.stringify(result)).not.toContain("不可显示的库存");
});

test("已拥有走 TabOwned，使用已有练度与装备，目标低于当前不会算成降级", async () => {
  const result = await readStarRailGrowth(source, async (url, init) => {
    if (url.pathname.endsWith("/avatar/info")) return envelope({ avatar_list: [avatar] });
    if (url.pathname.endsWith("/avatar/detail")) {
      expect(url.searchParams.get("tab_from")).toBe("TabOwned");
      return envelope({ ...detail, is_login: true, skills: detail.skills.map(row => ({ ...row, cur_level: row.max_level })) });
    }
    expect(JSON.parse(String(init.body))).toMatchObject({
      avatar: { cur_level: 80, target_level: 80 }, equipment: { item_id: 23002, cur_level: 60, target_level: 80 },
      skill_list: [4, 3, 2, 1].map(index => ({ item_id: 1107000 + index, cur_level: index === 1 ? 6 : 10, target_level: index === 1 ? 6 : 10 })),
    });
    return envelope({ avatar_consume: [], skill_consume: [], equipment_consume: [{ item_name: "信用点", num: 100 }] });
  }, query);
  expect(result).toMatchObject({ owned: true, rank: 1, avatar: { current: 80, target: 80 }, equipment: { current: 60, target: 80 },
    materials: { equipment_consume: [{ name: "信用点", total: 100 }] } });
});

test("换票后从本人角色重跑完整三步，已拥有时拒绝官方匿名 TabOwned 返回", async () => {
  let current = source;
  let exchanges = 0, computes = 0;
  const attempts: string[] = [];
  const client = createHoyoClient(async (url, init) => {
    const cookie = new Headers(init.headers).get("cookie")!;
    attempts.push(cookie);
    if (url.pathname.endsWith("/avatar/info")) return envelope({ avatar_list: [avatar] });
    if (url.pathname.endsWith("/avatar/detail")) return envelope({ ...detail, is_login: cookie === "cookie_token=test-renewed" });
    computes++;
    return envelope(results);
  }, {
    profiles: {
      async accountContext(qq, slot) { expect([qq, slot]).toEqual(["42", 2]); return current; },
      async saveRefreshedCredentials(qq, id, revision, update) {
        expect([qq, id, revision]).toEqual(["42", 2, source.revision]);
        current = { ...source, revision: "after-refresh", account: { ...source.account, cookie: update.cookie } };
        return current;
      },
      async saveRoles() { throw new Error("本查询不写角色"); },
    },
    async exchange(profile, options) { exchanges++; expect(profile.profileId).toBe(2);
      await options?.verifyProfile?.(); return { cookie: "cookie_token=test-renewed", ltoken: "" }; },
  });
  expect(await client.fetchStarRailGrowth(source, query)).toMatchObject({ owned: true, revision: "after-refresh", refreshedCookie: true });
  expect(exchanges).toBe(1);
  expect(computes).toBe(1);
  expect(attempts).toEqual([source.account.cookie, source.account.cookie, "cookie_token=test-renewed", "cookie_token=test-renewed", "cookie_token=test-renewed"]);
});

test("不向非国服或缺同档设备出站，不接错角色、异区、缺主行迹及风控响应", async () => {
  let calls = 0;
  const noNetwork = async () => { calls++; throw new Error("must never send"); };
  await expect(readStarRailGrowth({ ...source, role: { ...source.role, region: "prod_official_asia" } }, noNetwork, query))
    .rejects.toMatchObject({ code: "invalid-input" });
  await expect(readStarRailGrowth({ ...source, device: { ...source.device, fp: "" } }, noNetwork, query))
    .rejects.toMatchObject({ code: "invalid-input" });
  expect(calls).toBe(0);
  for (const wrong of [{ ...detail, avatar: { item_id: "1106" } }, { ...detail, region: "prod_gf_cn" },
    { ...detail, skills: detail.skills.slice(0, 2) }]) {
    let count = 0;
    await expect(readStarRailGrowth(source, async (url) => {
      count++;
      return envelope(url.pathname.endsWith("/avatar/info") ? { avatar_list: [] } : wrong);
    }, query)).rejects.toMatchObject({ code: "response" });
    expect(count).toBe(2);
  }
  await expect(readStarRailGrowth(source, async (url) => url.pathname.endsWith("/avatar/info") ? envelope({ avatar_list: [] }) :
    Response.json({ retcode: 0, data: {} }, { headers: { "x-rpc-aigis": '{"challenge":true}' } }), query))
    .rejects.toMatchObject({ reason: "risk" });
});

test("宿主命令分发和权限，换档或断开在途时不允许发送", async () => {
  const module = createModule({ signal, lockFile });
  const message = "#星铁克拉拉养成75 80 6 9 9 9 档案2";
  const event = { ...context, normalizedMessage: message, reply() {} };
  expect(await module.fallbackFeatures(event)).toEqual(["[starrail] 养成计算"]);
  expect(await module.fallback(message, { ...event, privateCredentialSignal: undefined })).toMatch(/本人档案/u);
  const model = await readStarRailGrowth(source, async url => url.pathname.endsWith("/avatar/info") ? envelope({ avatar_list: [] }) :
    url.pathname.endsWith("/avatar/detail") ? envelope(detail) : envelope(results), query);
  let selected = source, reads = 0;
  const run = createStarRailGrowthQuery({ async requestSelectedContext(qq, id) {
    expect([qq, id]).toEqual(["42", 2]); return selected;
  } }, { async fetchStarRailGrowth() { reads++; return { ...model, revision: source.revision, refreshedCookie: false }; } }, signal, {
    resolve: async () => ({ id: 1107, name: "克拉拉" }),
    render: async () => { selected = { ...source, revision: "changed" }; return { png: new Uint8Array([1, 2, 3]) }; },
  });
  const args = matchStarRailGrowth(message)!;
  expect(await run({ ...context, isDelegated: true }, args)).toMatch(/本人档案/u);
  expect(await run({ ...context, privateCredentialSignal: AbortSignal.abort() }, args)).toEqual([]);
  expect(await run({ ...context, message_type: "group", privateCredentialSignal: undefined }, args)).toMatch(/本人档案/u);
  expect(reads).toBe(0);
  expect(await run(context, args)).toMatch(/档案已变更/u);
  expect(reads).toBe(1);
});
