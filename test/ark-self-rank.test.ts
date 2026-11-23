import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { createArkSelfRankCommand, matchArkSelfRank } from "../lib/ark-self-rank.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const gsUid = "100000000";
const srUid = "700000000";
const other = "800000000";
const privateFriend = { user: 42, privateFriend: true, signal: new AbortController().signal, isCurrent: () => true };
const profile = {
  user: { qq: "42" }, profile: { id: 2 },
  account: { cookie: "account_id=900000002;cookie_token=fixture-only-cookie;ltuid=900000002;ltoken=fixture-only-ltoken",
    stuid: "900000002", stoken: "fixture-only-stoken", current_uid: { gs: gsUid, sr: srUid },
    game_roles: { gs: [{ uid: gsUid, region: "cn_gf01", game_biz: "hk4e_cn" }],
      sr: [{ uid: srUid, region: "prod_gf_cn", game_biz: "hkrpg_cn" }] },
  },
};

test("总排名保留两游前缀、档号和选填的本人 UID，发送前要求明示确认", () => {
  expect(matchArkSelfRank("#总排名")).toEqual({ game: "gs", profileId: 1, valid: true, confirmed: false });
  expect(matchArkSelfRank("#原神总排名2 确认")).toEqual({ game: "gs", profileId: 2, valid: true, confirmed: true });
  expect(matchArkSelfRank("#星铁总排名 档案 2 确认")).toEqual({ game: "sr", profileId: 2, valid: true, confirmed: true });
  expect(matchArkSelfRank("*总排名255")).toEqual({ game: "sr", profileId: 255, valid: true, confirmed: false });
  expect(matchArkSelfRank("#星铁总排名100000000 档案2 确认")).toEqual({
    game: "sr", profileId: 2, uid: "100000000", valid: true, confirmed: true,
  });
  for (const text of ["#总排名256 确认", "*总排名0 确认", "#星铁总排名100000000000 确认", "#总排名同意", "#总排名 确认 2"]) {
    expect(matchArkSelfRank(text)?.valid).toBeFalse();
  }
  expect(matchArkSelfRank("%总排名")).toBeUndefined();
  expect(matchArkSelfRank("#角色排名统计")).toBeUndefined();
});

test("实际读原铁本人档与本地面板，外发仅该游戏 UID 和实存角色编号", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-ark-self-rank-"));
  const gsPanels = join(directory, "gs");
  const srPanels = join(directory, "sr");
  const env = { LOTUS_GENSHIN_LEGACY_PANEL_DIR: gsPanels, LOTUS_STAR_RAIL_LEGACY_PANEL_DIR: srPanels };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, Bun.env[key]]));
  try {
    await Promise.all([mkdir(gsPanels), mkdir(srPanels), writeFile(join(directory, "42-2.yaml"), Bun.YAML.stringify(profile))]);
    await Promise.all([
      writeFile(join(gsPanels, `${gsUid}.json`), JSON.stringify({ uid: gsUid, privateMarker: "fixture-not-for-Ark", avatars: {
        10000046: { id: 10000046, name: "胡桃", level: 90, _source: "enka", weapon: { name: "护摩之杖", promote: 6 }, talent: { a: 8 } },
        10000077: { id: 10000077, name: "瑶瑶", level: 90, _source: "mys" },
        10000089: { id: 10000089, name: "芙宁娜", level: 90, _source: "enka" },
      } })),
      writeFile(join(srPanels, `${srUid}.json`), JSON.stringify({ uid: srUid, avatars: {
        1001: { id: 1001, name: "三月七", level: 80, _source: "enka" },
        1102: { id: 1102, name: "希儿", level: 80, _source: "enka" },
        1204: { id: 1204, name: "景元", level: 80 },
      } })),
    ]);
    Object.assign(Bun.env, env);
    const calls: object[] = [];
    const run = createArkSelfRankCommand(createProfileStore(directory), { async transport(url, init) {
      expect(url).toBe("https://ark.ivny.cn/rank/self");
      expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", headers: { "Content-Type": "application/json" } });
      expect(new Headers(init.headers).has("cookie")).toBeFalse();
      expect(new Headers(init.headers).has("authorization")).toBeFalse();
      const body = JSON.parse(init.body as string);
      calls.push(body);
      const rank = body.ids.map((_id: string, index: number) => index === 0
        ? { retcode: 100, rank: 25, score: 98.123 } : { retcode: 102 });
      return Response.json({ retcode: 100, rank });
    } });
    const gs = matchArkSelfRank("#原神总排名 档案2 确认")!;
    const sr = matchArkSelfRank("*总排名 2 确认")!;
    expect(await run(gs)).toContain("好友私聊");
    expect(await run(gs, { ...privateFriend, privateFriend: false })).toContain("好友私聊");
    const notice = await run(matchArkSelfRank("#星铁总排名2")!, privateFriend);
    expect(notice).toContain("UID、游戏类型和本地已保存的角色编号");
    expect(notice).toContain("*总排名 2 确认");
    expect(await run(gs, { ...privateFriend, user: 43 })).toContain("请先登录档案 2");
    expect(await run(matchArkSelfRank(`#星铁总排名${gsUid} 档案2 确认`)!, privateFriend)).toContain("与所选档案的本人星铁角色不一致");
    expect(calls).toEqual([]);
    expect(await run(gs, privateFriend)).toBe(`UID ${gsUid} 的原神全服排名\n胡桃全服伤害排名为 25，伤害评分 98.12`);
    expect(await run({ ...sr, uid: srUid }, privateFriend)).toBe(`UID ${srUid} 的星铁全服排名\n三月七全服伤害排名为 25，伤害评分 98.12\n1 个角色暂无排名。`);
    expect(calls).toEqual([
      { uid: gsUid, type: "gs", ids: ["10000046"], version: "2.1.0" },
      { uid: srUid, type: "sr", ids: ["1001", "1102"], version: "2.1.0" },
    ]);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("在读盘与收到排名后各检查一次换绑，也处理速率、错序和空排名", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-ark-self-rank-change-"));
  try {
    const file = join(directory, "42-2.yaml");
    const save = (changed = false) => writeFile(file, Bun.YAML.stringify(changed ? { ...profile,
      account: { ...profile.account, current_uid: { gs: other, sr: srUid } } } : profile));
    await save();
    let stage = "disk";
    let calls = 0;
    const avatars = [{ id: 10000046, name: "胡桃" }, { id: 10000077, name: "瑶瑶" }];
    const run = createArkSelfRankCommand(createProfileStore(directory), {
      async readCharacters() { if (stage === "disk") await save(true); return avatars; },
      async transport() {
        calls++;
        if (stage === "network") await save(true);
        if (stage === "429") return new Response(null, { status: 429 });
        if (stage === "business") return Response.json({ retcode: 202 });
        if (stage === "length") return Response.json({ retcode: 100, rank: [] });
        if (stage === "row") return Response.json({ retcode: 100, rank: [{ retcode: 100, id: 10000077, rank: 1, score: 4 }, { retcode: 102 }] });
        return Response.json({ retcode: 100, rank: [{ retcode: 102 }, { retcode: 102 }] });
      },
    });
    const command = matchArkSelfRank("#总排名2确认")!;
    expect(await run(command, privateFriend)).toContain("档案已变更");
    expect(calls).toBe(0);
    await save();
    stage = "network";
    expect(await run(command, privateFriend)).toContain("档案已变更");
    expect(calls).toBe(1);
    await save();
    for (const [kind, message] of [["429", "查询过于频繁"], ["business", "暂无该档案"], ["length", "角色条数与档案不符"],
      ["row", "未能确认"], ["empty", "角色暂无全服伤害排名"]]) {
      stage = kind!;
      expect(await run(command, privateFriend)).toContain(message!);
    }
    let active = true;
    const large = createArkSelfRankCommand(createProfileStore(directory), {
      async readCharacters() { return Array.from({ length: 31 }, (_, i) => ({ id: 10000070 + i, name: `角色${i + 1} ` })); },
      async transport() {
        return Response.json({ retcode: 100, rank: Array.from({ length: 31 }, () => ({ retcode: 100, rank: 1, score: 32 })) });
      },
    });
    const pages = await large(command, { ...privateFriend, isCurrent: () => active });
    expect(pages).toEqual([expect.stringContaining("原神全服排名（1/2）"), expect.stringContaining("角色31全服伤害排名")]);
    active = false;
    expect(await large(command, { ...privateFriend, isCurrent: () => active })).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("宿主按实际中文前缀在绑定好友私聊出提示和登录回执，群聊不给档案数据", async () => {
  const noExternal = `
    const localFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      if (new URL(url instanceof Request ? url.url : url).hostname !== "127.0.0.1") throw new Error("unexpected external call");
      return localFetch(url, init);
    };
  `;
  await withDualGatewayFixture("ark-self-rank-fixture", 'master: ["99:42", "100:43"]\ndisablePrivate: false\n',
    async ({ onebot, milky, sendOneBot, sendMilky }) => {
      sendOneBot("#总排名 档案2");
      expect((await onebot.next("send_msg")).params).toMatchObject({ user_id: 42, message: expect.stringContaining("#总排名 2 确认") });
      sendOneBot("#原神总排名2 确认");
      expect((await onebot.next("send_msg")).params).toMatchObject({ user_id: 42, message: "请先登录档案 2。" });
      await sendMilky("*总排名");
      const milkyPrompt = await milky.next("send_private_message");
      expect(milkyPrompt.params).toMatchObject({ user_id: 43, message: [{ data: { text: expect.stringContaining("*总排名 确认") } }] });
      milkyPrompt.respond({ message_seq: 604 });
      await sendMilky("#星铁总排名 确认");
      const milkyLogin = await milky.next("send_private_message");
      expect(milkyLogin.params).toMatchObject({ user_id: 43, message: [{ data: { text: "请先登录档案 1。" } }] });
      milkyLogin.respond({ message_seq: 605 });
      sendOneBot("#总排名 确认", { message_type: "group", sub_type: "normal", group_id: 701 });
      expect((await onebot.next("send_msg")).params).toMatchObject({ group_id: 701, message: expect.stringContaining("好友私聊") });
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    }, 4_000, noExternal);
}, 15_000);
