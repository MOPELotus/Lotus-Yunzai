import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const journal = "data/redeemCodes/manual.json";
const preload = `
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
process.env.LOTUS_PROFILE_DIR = join(process.cwd(), "data/users");
const real = globalThis.fetch;
const ok = data => Response.json({ retcode: 0, data });
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1") return real(input, init);
  const cookie = new Headers(init.headers).get("cookie");
  const biz = url.searchParams.get("game_biz");
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "omit");
  if (url.hostname === "api-account-os.hoyolab.com") {
    const genshin = biz === "hk4e_global";
    const account = genshin ? "71" : "72";
    appendFileSync("queries", biz + "\\n");
    assert.equal(url.pathname, "/binding/api/getUserGameRolesBy" + (genshin ? "CookieToken" : "Ltoken"));
    assert.equal(cookie, genshin ? "account_id=71; cookie_token=fixture-71" : "ltuid=72; ltoken=fixture-activity-72");
    return ok({ aid: account, list: genshin ? [
      { game_uid: "800000081", region: "os_asia", game_biz: biz },
      { game_uid: "700000081", region: "os_euro", game_biz: biz, is_chosen: true },
    ] : [
      { game_uid: "800000082", region: "prod_official_asia", game_biz: biz, is_chosen: true },
      { game_uid: "700000082", region: "prod_official_eur", game_biz: biz },
    ]});
  }
  if (url.hostname === "sg-hk4e-api.hoyolab.com" || url.hostname === "sg-hkrpg-api.hoyolab.com") {
    const genshin = url.hostname === "sg-hk4e-api.hoyolab.com";
    const uid = url.searchParams.get("uid"), region = url.searchParams.get("region");
    const code = url.searchParams.get("cdkey");
    const account = genshin ? "71" : "72";
    assert.equal(url.pathname, "/common/apicdkey/api/webExchangeCdkeyHyl");
    assert.equal(biz, genshin ? "hk4e_global" : "hkrpg_global");
    assert.equal(uid, genshin ? "800000081" : "800000082");
    assert.equal(region, genshin ? "os_asia" : "prod_official_asia");
    assert.equal(cookie, "account_id=" + account + "; cookie_token=fixture-" + account);
    const key = createHash("sha256").update(JSON.stringify([account, genshin ? "gs" : "sr", region, uid, code.toLowerCase()])).digest("hex");
    assert.equal(JSON.parse(readFileSync(${JSON.stringify(journal)}, "utf8"))[key].status, "started");
    appendFileSync("submissions", code + "\\n");
    if (code === "FIXTURE-LOST") throw new Error("模拟官方已收请求后断线");
    if (code === "FIXTURE-EXPIRED") return Response.json({ retcode: -100 });
    if (code === "FIXTURE-INVALID") return Response.json({ retcode: -2003 });
    return ok({msg: "模拟兑换成功"});
  }
  throw new Error("非预期联网请求");
}, { preconnect: real.preconnect });
`;

test("三游旧语法路由，原铁只兑本人国际服，群提示不回显兑换码且丢失结果不重投", async () => {
  await withDualGatewayFixture("manual-redeem-fixture", "disablePrivate: false\n", async ({ root, onebot, milky, sendOneBot, sendMilky }) => {
    const submissions = () => readFile(join(root, "submissions"), "utf8").catch(() => "");
    const queries = () => readFile(join(root, "queries"), "utf8").catch(() => "");
    async function reply(text: string, fields: object = {}) {
      sendOneBot(text, fields);
      const call = await onebot.next("send_msg").catch(error => { throw new Error(text, { cause: error }); });
      call.respond({ message_id: 930 });
      return call.params;
    }
    expect(await reply("#cdk-uFIXTURE-GROUP", { message_type: "group", sub_type: "normal", group_id: 707 }))
      .toMatchObject({ group_id: 707, message: "请在机器人好友私聊中使用兑换码。" });
    expect(await submissions()).toBe("");
    expect(await queries()).toBe("");

    expect(await reply("%兑换码使用FIXTURE-ZZZ")).toMatchObject({ user_id: 42, message: "绝区零请在游戏内兑换。" });
    expect(await reply("#cdk-uFIXTURE-OTHER", { user_id: 65 })).toMatchObject({
      user_id: 65, message: expect.stringContaining("重新绑定已核验的 HoYoLAB Cookie"),
    });
    expect(await queries()).toBe("");

    expect(await reply("#兑换码使用FIXTURE-GS")).toMatchObject({
      user_id: 42, message: "原神国际服兑换 · 档案 1\n使用成功",
    });
    expect(await reply("#cdk-uFixture-Gs")).toMatchObject({ user_id: 42, message: expect.stringContaining("已提交过") });

    expect((await sendMilky("*cdk-u FIXTURE-SR 档案2")).status).toBe(200);
    const starRail = await milky.next("send_private_message");
    expect(starRail.params).toMatchObject({ user_id: 43, message: [
      { type: "text", data: { text: "星铁国际服兑换 · 档案 2\n使用成功" } },
    ] });
    starRail.respond({ message_seq: 931 });
    expect(await reply("#原神cdk-u FIXTURE-INVALID")).toMatchObject({ message: expect.stringContaining("兑换码无效") });
    expect(await reply("#原神cdk-uFIXTURE-EXPIRED")).toMatchObject({
      message: expect.stringContaining("重新绑定已核验的 HoYoLAB Cookie"),
    });
    expect(await reply("#原神cdk-uFIXTURE-LOST")).toMatchObject({ message: expect.stringContaining("结果未确认") });
    expect(await reply("#兑换码使用 fixture-lost")).toMatchObject({ message: expect.stringContaining("已提交过") });
    expect(await submissions()).toBe("FIXTURE-GS\nFIXTURE-SR\nFIXTURE-INVALID\nFIXTURE-EXPIRED\nFIXTURE-LOST\n");
    const data = await readFile(join(root, journal), "utf8");
    const hash = createHash("sha256").update(JSON.stringify(["71", "gs", "os_asia", "800000081", "fixture-lost"])).digest("hex");
    expect(JSON.parse(data)[hash].status).toBe("finished");
    expect(data).not.toMatch(/fixture|800000081|cookie/iu);
  }, 3_000, preload, async root => {
    await mkdir(join(root, "data/users"), { recursive: true });
    const profile = (id: number, account: number, roles: string) => [
      "enabled: false",
      `profile: { id: ${id} }`,
      `account: { stuid: '9', mid: domestic, stoken: v2_fixture, cookie: 'account_id_v2=9; cookie_token_v2=v2_domestic; account_mid_v2=domestic; ltuid_v2=9; ltoken_v2=v2_activity; ltmid_v2=domestic', current_uid: ${roles} }`,
      "games:", "  os:", "    enable: false",
      `    cookie: 'account_id=${account}; cookie_token=fixture-${account}'`,
      `    verified_activity_cookie: 'ltuid=${account}; ltoken=fixture-activity-${account}'`,
      `    verified_account_id: '${account}'`, "    verified_realm: SG",
    ].join("\n");
    await writeFile(join(root, "data/users/42.yaml"), profile(1, 71, "{ gs: '800000081' }"));
    await writeFile(join(root, "data/users/43-2.yaml"), profile(2, 72, "{ sr: '81' }"));
    await writeFile(join(root, "config/global.yaml"), "coin_shop: { enable: false }\n");
  });
}, 15_000);
