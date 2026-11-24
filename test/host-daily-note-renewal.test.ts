import { expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const previous = "100000042", expired = "200000042", retained = "300000042";
const starRail = "500000042", zzz = "12345642", otherZzz = "12345643", defaultUid = "100000041";
const retired = [previous, expired];
const gameRole = (uid: string, region: string, game_biz: string) => ({ uid, region, game_biz });
const group = {
  gs: [previous, expired, retained].map(uid => gameRole(uid, "cn_gf01", "hk4e_cn")),
  sr: [gameRole(starRail, "prod_qd_cn", "hkrpg_cn")],
  zzz: [gameRole(zzz, "prod_gf_cn", "nap_cn")],
};
const preload = `
import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_DAILY_NOTE_RESOURCES = "./unavailable-artwork-for-text-fallback";
const roles = ${JSON.stringify(group)};
const previous = ${JSON.stringify(previous)}, expired = ${JSON.stringify(expired)}, retained = ${JSON.stringify(retained)};
const starRail = ${JSON.stringify(starRail)}, zzz = ${JSON.stringify(zzz)}, otherZzz = ${JSON.stringify(otherZzz)};
const defaultUid = ${JSON.stringify(defaultUid)};
const native = globalThis.fetch;
const ok = data => Response.json({ retcode: 0, data });
function event(...parts) {
  appendFileSync("./requests.jsonl", JSON.stringify(parts) + "\\n");
}
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return native(input, init);
  const headers = new Headers(init?.headers);
  const cookie = headers.get("cookie") ?? "";
  if (url.origin === "https://passport-api.mihoyo.com" && url.pathname === "/account/ma-cn-session/app/exchange") {
    const body = JSON.parse(String(init.body));
    assert.equal(init.method, "POST");
    assert.equal(body.src_token.token, "v2_fixture_42");
    assert.equal(body.mid, "fixture-mid-42");
    assert.equal(headers.get("x-rpc-device_id"), "fixture-device-42");
    assert.ok(body.dst_token_type === 2 || body.dst_token_type === 4);
    event("exchange", body.dst_token_type);
    return ok({ token: { token: body.dst_token_type === 2 ? "v2_fresh_ltoken_42" : "v2_fresh_cookie_42" },
      user_info: { aid: "42" } });
  }
  if (url.origin === "https://api-takumi.mihoyo.com" && url.pathname === "/binding/api/getUserGameRolesByCookie") {
    assert.ok(cookie.includes("v2_fresh_cookie_42"));
    event("roles");
    return ok({ list: [...roles.gs.filter(role => role.uid === retained), ...roles.sr, ...roles.zzz]
      .map(({ uid, ...fields }) => ({ game_uid: uid, ...fields })) });
  }
  if (url.origin === "https://api-takumi.mihoyo.com" && url.pathname === "/event/luna/hkrpg/info") {
    assert.equal(init.method, "GET");
    assert.equal(url.searchParams.get("uid"), starRail);
    assert.equal(url.searchParams.get("region"), "prod_qd_cn");
    assert.ok(cookie.includes("v2_fresh_cookie_42"));
    event("starrail-checkin", starRail);
    return ok({ is_sign: false });
  }
  if (url.origin === "https://api-takumi-record.mihoyo.com") {
    const uid = url.searchParams.get("role_id");
    const account = uid === otherZzz ? "43" : uid === defaultUid ? "41" : "42";
    const target = [previous, expired, retained, defaultUid].includes(uid) ? "/game_record/app/genshin/api/dailyNote"
      : uid === starRail ? "/game_record/app/hkrpg/api/note" : "/event/game_record_zzz/api/zzz/note";
    assert.equal(url.pathname, target);
    assert.equal(init.method, "GET");
    assert.equal(headers.get("x-rpc-device_id"), "fixture-device-" + account);
    assert.equal(url.searchParams.get("server"), uid === starRail ? "prod_qd_cn"
      : uid === zzz || uid === otherZzz ? "prod_gf_cn" : "cn_gf01");
    assert.equal(headers.get("x-rpc-device_fp"), "fixture-fp-" + account);
    assert.ok(cookie.includes("account_id_v2=" + account + ";"));
    const renewed = cookie.includes("v2_fresh_cookie_42");
    event("note", uid, renewed ? "fresh" : "stored");
    if (uid === defaultUid && existsSync("./cancel-daily-note")) {
      await Bun.sleep(350);
      event("note-after-disconnect", init.signal.aborted);
      return Response.json({ retcode: -100 });
    }
    if (uid === expired && !renewed) return Response.json({ retcode: -100 });
    if (uid === starRail) return ok({ current_stamina: 37, max_stamina: 300 });
    if (uid === zzz || uid === otherZzz) return ok({
      energy: { progress: { current: 12, max: 240, rest: "距离电量回满 3 小时" } },
      vhs_sale: { text: "今日可以营业" }, vitality: { current: 0, max: 400 }, card_sign: { status: false },
    });
    return ok({ current_resin: uid === previous ? 17 : uid === expired ? 18 : 66, max_resin: 200 });
  }
  event("unexpected", url.origin);
  throw new Error("isolated host");
}, { preconnect: native.preconnect });
`;

async function prepare(root: string) {
  await symlink(join(import.meta.dir, "../packages"), join(root, "packages"), "dir");
  const directory = join(root, "profiles");
  await mkdir(directory);
  async function profile(file: string, qq: number, id: number, mid: number, roles: object) {
    await Bun.write(join(directory, file), Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id },
      account: { stuid: String(mid), stoken: `v2_fixture_${mid}`, mid: `fixture-mid-${mid}`,
        cookie: `account_id_v2=${mid};account_mid_v2=fixture-mid-${mid};cookie_token_v2=v2_stored_cookie_${mid};`,
        stoken_cookie: `stuid=${mid};stoken=v2_fixture_${mid};mid=fixture-mid-${mid};`, game_roles: roles },
      device: { id: `fixture-device-${mid}`, fp: `fixture-fp-${mid}` },
    }));
  }
  await profile("42.yaml", 42, 1, 41, { gs: [gameRole(defaultUid, "cn_gf01", "hk4e_cn")] });
  await profile("42-2.yaml", 42, 2, 42, group);
  await profile("43.yaml", 43, 1, 43, { zzz: [gameRole(otherZzz, "prod_gf_cn", "nap_cn")] });
}

test("全部体力续期后只查仍绑定的 UID，其他角色与档案结果照常，并保留旧绝区零状态文案", async () => {
  await withDualGatewayFixture("daily-note-renewal-fixture", "disablePrivate: false\n", async ({
    root, sendOneBot, sendMilky, onebot, milky,
  }) => {
    sendOneBot("#全便笺2");
    const progress = await onebot.next("send_msg");
    expect(progress.params).toMatchObject({ user_id: 42, message: expect.stringContaining("profile 2") });
    progress.respond({ message_id: 41 });
    const page = await onebot.next("send_msg");
    page.respond({ message_id: 42 });

    expect((await sendMilky("%便签")).status).toBe(200);
    const other = await milky.next("send_private_message");
    expect(JSON.stringify(other.params)).toContain("所有 profile");
    other.respond({ message_seq: 43 });
    const otherPage = await milky.next("send_private_message");
    otherPage.respond({ message_seq: 44 });

    sendOneBot("树脂");
    const all = await onebot.next("send_msg");
    expect(all.params).toMatchObject({ user_id: 42, message: expect.stringContaining("所有 profile") });
    all.respond({ message_id: 45 });
    const allPage = await onebot.next("send_msg");
    allPage.respond({ message_id: 46 });

    const trace = (await Bun.file(join(root, "requests.jsonl")).text()).trim().split("\n")
      .map(line => JSON.parse(line) as unknown);
    expect(trace).toEqual([
      ["note", previous, "stored"], ["note", expired, "stored"], ["exchange", 2], ["exchange", 4], ["roles"],
      ["note", retained, "fresh"], ["note", starRail, "fresh"], ["starrail-checkin", starRail],
      ["note", zzz, "fresh"], ["note", otherZzz, "stored"],
      ["note", defaultUid, "stored"], ["note", retained, "fresh"],
    ]);
    const first = JSON.stringify(page.params), second = JSON.stringify(otherPage.params), third = JSON.stringify(allPage.params);
    expect(first).toContain("66/200");
    expect(first).toContain("37/300");
    expect(first).toContain("今日米游社 未签到");
    for (const stale of ["17/200", "18/200", defaultUid, otherZzz]) expect(first).not.toContain(stale);
    expect(first?.match(/该角色已不在续期后的档案中/gu)).toHaveLength(retired.length);
    for (const page of [first, second]) {
      expect(page).toContain("距离电量回满 3 小时");
      expect(page).toContain("今日可以营业");
      expect(page).toContain("0/400");
      expect(page).toContain("未完成");
    }
    expect(third).toContain(`Profile 1 · 原神 · UID ${defaultUid}`);
    expect(third).toContain(`Profile 2 · 原神 · UID ${retained}`);
    expect(Bun.YAML.parse(await Bun.file(join(root, "profiles/42-2.yaml")).text())).toMatchObject({
      account: { cookie: expect.stringContaining("v2_fresh_cookie_42"), game_roles: { gs: [{ uid: retained }] } },
    });
  }, 8_000, preload, prepare);
}, 25_000);

test("群会话断开后取消进行中的体力请求，迟到的过期结果不触发续期或后续档案", async () => {
  await withDualGatewayFixture("daily-note-disconnect-fixture", "disablePrivate: false\n", async ({
    root, ws, sendOneBot, onebot,
  }) => {
    await Bun.write(join(root, "cancel-daily-note"), "");
    sendOneBot("#树脂", { message_type: "group", sub_type: "normal", group_id: 11 });
    const progress = await onebot.next("send_msg");
    expect(progress.params).toMatchObject({ group_id: 11, message: expect.stringContaining("所有 profile") });
    progress.respond({ message_id: 41 });
    async function trace() {
      return Bun.file(join(root, "requests.jsonl")).text().catch(() => "");
    }
    for (let i = 0; i < 100 && !(await trace()).includes(defaultUid); i++) await Bun.sleep(10);
    expect(await trace()).toContain(defaultUid);
    ws.close();
    for (let i = 0; i < 120 && !(await trace()).includes("note-after-disconnect"); i++) await Bun.sleep(10);
    expect((await trace()).trim().split("\n").map(line => JSON.parse(line))).toEqual([
      ["note", defaultUid, "stored"], ["note-after-disconnect", true],
    ]);
  }, 8_000, preload, prepare);
}, 25_000);
