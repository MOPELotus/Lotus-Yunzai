import { linkHostPackages } from "./host-fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const uids = { 42: "100000042", 43: "100000043", 45: "100000045" };
const replacements = { 43: "100000044", 45: "100000046" };
const role = (uid: string) => ({ uid, region: "cn_gf01", game_biz: "hk4e_cn" });
const row = (id: string, uid: string, name: string) => ({ id, uid, name, gacha_type: "301" });
const previous = (uid: string) => JSON.stringify([row("20", uid, "旧记录")]);
const profiles = [[42, 2, 42], [43, 2, 43], [43, 3, 45]] as const;
const preload = `
import { appendFileSync } from "node:fs";
import assert from "node:assert/strict";
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
const native = globalThis.fetch;
const uids = ${JSON.stringify(uids)};
const replacements = ${JSON.stringify(replacements)};
const authCounts = new Map();
function record(account, operation) {
  appendFileSync("./requests.jsonl", JSON.stringify({ account, operation }) + "\\n");
}
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return native(input, init);
  const headers = new Headers(init?.headers);
  const cookie = headers.get("Cookie") ?? "";
  assert.equal(init?.redirect, "error");
  if (url.origin === "https://api-takumi.mihoyo.com" && url.pathname === "/binding/api/genAuthKey") {
    const account = /(?:^|;)\\s*stuid=(42|43|45)(?:;|$)/u.exec(cookie)?.[1];
    assert.ok(account);
    assert.equal(headers.get("x-rpc-device_id"), "fixture-gacha-device-" + account);
    assert.deepEqual(JSON.parse(String(init.body)), {
      auth_appid: "webview_gacha", game_biz: "hk4e_cn", game_uid: Number(uids[account]), region: "cn_gf01",
    });
    record(account, "auth");
    const attempts = (authCounts.get(account) ?? 0) + 1;
    authCounts.set(account, attempts);
    return Response.json(attempts === 1 ? { retcode: "-100" } : { retcode: 0, data: { authkey: "fixture-" + account } });
  }
  if (url.origin === "https://passport-api.mihoyo.com" && url.pathname === "/account/ma-cn-session/app/exchange") {
    const body = JSON.parse(String(init.body));
    const account = /^v2_fixture_(42|43|45)$/u.exec(body.src_token?.token)?.[1];
    assert.ok(account);
    assert.equal(body.mid, "fixture-mid-" + account);
    assert.equal(headers.get("x-rpc-device_id"), "fixture-gacha-device-" + account);
    assert.ok(body.dst_token_type === 2 || body.dst_token_type === 4);
    record(account, "exchange-" + body.dst_token_type);
    return Response.json({ retcode: 0, data: {
      token: { token: (body.dst_token_type === 2 ? "v2_fresh_ltoken_" : "v2_fresh_cookie_") + account },
      user_info: { aid: account },
    } });
  }
  if (url.origin === "https://api-takumi.mihoyo.com" && url.pathname === "/binding/api/getUserGameRolesByCookie") {
    const account = /cookie_token_v2=v2_fresh_cookie_(42|43|45)(?:;|$)/u.exec(cookie)?.[1];
    assert.ok(account);
    record(account, "roles");
    const uid = replacements[account] ?? uids[account];
    return Response.json({ retcode: 0, data: { list: [{ game_uid: uid, region: "cn_gf01", game_biz: "hk4e_cn" }] } });
  }
  if (url.origin === "https://public-operation-hk4e.mihoyo.com" && url.pathname === "/gacha_info/api/getGachaLog") {
    const account = /^fixture-(42|43)$/u.exec(url.searchParams.get("authkey") ?? "")?.[1];
    assert.ok(account);
    assert.equal(cookie, "");
    const pool = url.searchParams.get("gacha_type"), page = url.searchParams.get("page");
    record(account, "pool-" + pool + "-" + page);
    const list = pool === "301" && page === "1" ? [
      { id: "90", uid: uids[account], name: "新增记录", gacha_type: "301" },
    ] : [];
    return Response.json({ retcode: 0, data: { region: "cn_gf01", uid: uids[account], list } });
  }
  record("unexpected", url.origin);
  throw new Error("isolated upstream");
}, { preconnect: native.preconnect });
`;

const historyPath = (root: string, qq: number, uid: string) =>
  join(root, "data", "gachaJson", String(qq), uid, "301.json");
const profilePath = (root: string, qq: number, id: number) => join(root, "profiles", `${qq}-${id}.yaml`);

async function prepare(root: string) {
  const source = join(import.meta.dir, "../plugins/genshin");
  const target = join(root, "plugins/genshin");
  await cp(source, target, { recursive: true, filter: file => ![".git", "node_modules"].includes(basename(file)) });
  await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
  await linkHostPackages(root);
  await mkdir(join(root, "profiles"), { recursive: true });
  for (const [qq, id, account] of profiles) {
    const uid = uids[account];
    await writeFile(profilePath(root, qq, id), Bun.YAML.stringify({
      user: { qq: String(qq) }, profile: { id }, account: {
        stuid: String(account), stoken: `v2_fixture_${account}`, mid: `fixture-mid-${account}`,
        stoken_cookie: `stuid=${account};stoken=v2_fixture_${account};mid=fixture-mid-${account}`,
        cookie: `account_id_v2=${account};account_mid_v2=fixture-mid-${account};cookie_token_v2=v2_stored_cookie_${account}`,
        game_roles: { gs: account === 42 ? [uid] : [role(uid), role(replacements[account])] },
        current_uid: { gs: uid },
      }, device: { id: `fixture-gacha-device-${account}` },
    }));
    const archive = historyPath(root, qq, uid);
    await mkdir(dirname(archive), { recursive: true });
    await writeFile(archive, previous(uid));
  }
}

test("原神官方更新依同档续期后只重查仍选中的角色，并保留已解绑角色的本地记录", async () => {
  await withDualGatewayFixture("genshin-gacha-renewal-fixture", "disablePrivate: false\n", async ({
    root, onebot, milky, sendOneBot, sendMilky,
  }) => {
    sendOneBot("#更新抽卡记录2");
    const started = await onebot.next("send_msg");
    expect(started.params).toMatchObject({ user_id: 42, message: expect.stringContaining("正在更新原神抽卡记录（档案 2）") });
    started.respond({ message_id: 41 });
    const completed = await onebot.next("send_msg");
    completed.respond({ message_id: 42 });

    expect((await sendMilky("#原神更新抽卡记录2")).status).toBe(200);
    const otherStarted = await milky.next("send_private_message");
    expect(JSON.stringify(otherStarted.params)).toContain("正在更新原神抽卡记录（档案 2）");
    otherStarted.respond({ message_seq: 43 });
    const rejected = await milky.next("send_private_message");
    rejected.respond({ message_seq: 44 });

    expect((await sendMilky("#同步外部抽卡记录3")).status).toBe(200);
    const externalStarted = await milky.next("send_private_message");
    expect(JSON.stringify(externalStarted.params)).toContain("提瓦特小助手");
    externalStarted.respond({ message_seq: 45 });
    const externalRejected = await milky.next("send_private_message");
    expect(JSON.stringify(externalRejected.params)).toContain("续期后原神档案的角色已变更");
    externalRejected.respond({ message_seq: 46 });

    const merged = await Bun.file(historyPath(root, 42, uids[42])).json();
    expect(merged).toEqual([row("90", uids[42], "新增记录"), row("20", uids[42], "旧记录")]);
    for (const [qq, id, account] of profiles) {
      const saved = Bun.YAML.parse(await Bun.file(profilePath(root, qq, id)).text());
      expect(saved).toMatchObject({ account: { cookie: expect.stringContaining("v2_fresh_cookie_" + account),
        current_uid: { gs: account === 42 ? uids[42] : replacements[account] } } });
      if (account !== 42) {
        expect(await Bun.file(historyPath(root, qq, uids[account])).text()).toBe(previous(uids[account]));
        expect(await Bun.file(historyPath(root, qq, replacements[account])).exists()).toBe(false);
      }
    }
    const trace = (await Bun.file(join(root, "requests.jsonl")).text()).trim().split("\n")
      .map(line => JSON.parse(line) as { account: string; operation: string });
    const requests = (account: string) => trace.filter(entry => entry.account === account).map(entry => entry.operation);
    expect(requests("42")).toEqual(["auth", "exchange-2", "exchange-4", "roles", "auth",
      "pool-301-1", "pool-301-2", "pool-302-1", "pool-500-1", "pool-200-1"]);
    expect(requests("43")).toEqual(["auth", "exchange-2", "exchange-4", "roles"]);
    expect(requests("45")).toEqual(["auth", "exchange-2", "exchange-4", "roles"]);
    expect(requests("unexpected")).toEqual([]);
  }, 12_000, preload, prepare);
}, 30_000);
