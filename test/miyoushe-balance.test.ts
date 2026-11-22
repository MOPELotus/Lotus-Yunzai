import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { miyousheBalanceProfile } from "../lib/miyoushe-balance.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

function profile(qq: number, slot: number, account: number) {
  const suffix = String(account);
  return {
    user: { qq: String(qq) }, profile: { id: slot },
    account: {
      cookie: `ltoken_v2=v2_fixture-lt-${suffix};ltuid_v2=${suffix};ltmid_v2=fixture-mid-${suffix};cookie_token_v2=v2_fixture-ck-${suffix};account_id_v2=${suffix};account_mid_v2=fixture-mid-${suffix};`,
      stoken: `v2_fixture-st-${suffix}`, stuid: suffix, mid: `fixture-mid-${suffix}`,
      stoken_cookie: `stoken=v2_fixture-st-${suffix};stuid=${suffix};mid=fixture-mid-${suffix};`,
    },
    device: { id: `fixture-device-${suffix}`, fp: `fixture-fp-${suffix}` },
  };
}

test("币查询保留旧两个别名，同时区分档案编号和其他任务", () => {
  for (const command of ["#米游币查询", "米币查询", "##米游币查询"]) {
    expect(miyousheBalanceProfile(command)).toBe(1);
  }
  expect(miyousheBalanceProfile("#米币查询2")).toBe(2);
  for (const command of ["#米游币全部签到", "#云原神查询", "#米游币兑换", "#米币查询 42", "#米币查询2 42"]) {
    expect(miyousheBalanceProfile(command)).toBeUndefined();
  }
});

test("OneBot 和 Milky 从当前发送者只读币余额，保留零值，过期只续期指定档案", async () => {
  const trace = "balance-requests.jsonl";
  const preload = `
import { appendFile } from "node:fs/promises";
import assert from "node:assert/strict";
const localhostFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1") return localhostFetch(input, init);
  const headers = new Headers(init?.headers);
  const cookie = Object.fromEntries((headers.get("cookie") ?? "").split(";").filter(Boolean).map(field => field.trim().split("=")));
  const account = cookie.account_id_v2 ?? cookie.stuid;
  const log = (kind, identity = account) => appendFile(${JSON.stringify(trace)}, JSON.stringify({ kind, account: identity, method: init?.method }) + "\\n");
  if (url.hostname === "passport-api.mihoyo.com") {
    const input = JSON.parse(init.body);
    const kind = input.dst_token_type === 2 ? "ltoken" : "cookie_token";
    await log(kind, "8202");
    assert.equal(url.pathname, "/account/ma-cn-session/app/exchange");
    assert.equal(init?.method, "POST");
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("x-rpc-device_id"), "fixture-device-8202");
    assert.deepEqual(input.src_token, { token: "v2_fixture-st-8202", token_type: 1 });
    assert.equal(input.mid, "fixture-mid-8202");
    assert([2, 4].includes(input.dst_token_type));
    return Response.json({ retcode: 0, data: { token: { token: "v2_fixture-renewed-" + kind },
      user_info: { aid: "8202", mid: "fixture-mid-8202" } } });
  }
  if (url.hostname === "api-takumi.mihoyo.com" && url.pathname === "/binding/api/getUserGameRolesByCookie") {
    assert.equal(account, "8202");
    assert.equal(cookie.cookie_token_v2, "v2_fixture-renewed-cookie_token");
    await log("roles");
    return Response.json({ retcode: 0, data: { list: [] } });
  }
  if (url.hostname !== "bbs-api.miyoushe.com") {
    await log("blocked");
    throw Error("Offline fixture");
  }
  await log("balance");
  assert.equal(url.pathname, "/apihub/wapi/getUserMissionsState");
  assert.equal(url.search, "?point_sn=myb");
  assert.equal(init?.method, "GET");
  assert.equal(cookie.stoken, undefined);
  assert.equal(init?.redirect, "error");
  assert.equal(init?.credentials, "omit");
  if (account === "8202" && cookie.cookie_token_v2 !== "v2_fixture-renewed-cookie_token") {
    return Response.json({ retcode: -100, message: "upstream-text-never-send" });
  }
  if (account === "8203") return Response.json({ retcode: 12345, message: "upstream-text-never-send" }, { status: 401 });
  if (account === "8204") {
    while (!await Bun.file("balance-release").exists()) await Bun.sleep(5);
  }
  const fields = account === "8202" ? { total_points: 0, can_get_points: "0" }
    : account === "8301" ? { total_points: 520, can_get_points: 11 }
    : account === "8204" ? { total_points: 646464, can_get_points: 2 }
    : { total_points: 245, can_get_points: -1 };
  return Response.json({ retcode: 0, data: { uid: account, states: [], ...fields } });
};
`;
  const initial = new Map([
    ["42.yaml", profile(42, 1, 8201)], ["42-2.yaml", profile(42, 2, 8202)],
    ["42-3.yaml", profile(42, 3, 8203)], ["42-4.yaml", profile(42, 4, 8204)],
    ["43.yaml", profile(43, 1, 8301)],
  ]);
  const path = (root: string, basename: string) => join(root, "fixture-profiles", basename);
  const frozen = (basename: string) => Bun.YAML.stringify(initial.get(basename));
  await withDualGatewayFixture("miyoushe-balance-local", "disablePrivate: false\n", async ({ root, sendOneBot, onebot, sendMilky, milky }) => {
    const readTrace = async () => {
      const content = await readFile(join(root, trace), "utf8").catch(() => "");
      return content.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { kind: string; account: string; method: string });
    };
    const oneBotBalance = async (command: string, fields?: object) => {
      sendOneBot(command, fields);
      const reply = await onebot.next("send_msg");
      reply.respond({ message_id: 501 });
      return reply.params;
    };
    expect(await oneBotBalance("#米游币查询")).toMatchObject({
      user_id: 42, message: expect.stringContaining("当前米游币数量为：245\n今日剩余可获取：暂未返回"),
    });
    const group = { message_type: "group", sub_type: "normal", group_id: 77 };
    const selected = await oneBotBalance("#米币查询2", group);
    expect(selected.group_id).toBe(77);
    expect(selected.message).toMatchObject([
      { type: "at", data: { qq: "42" } },
      { type: "text", data: { text: "\n档案 2\n当前米游币数量为：0\n今日剩余可获取：0" } },
    ]);
    expect(await oneBotBalance("#米游币查询2", { ...group, user_id: 43, sender: { user_id: 43 } })).toMatchObject({
      group_id: 77, message: [{ type: "at", data: { qq: "43" } },
        { type: "text", data: { text: expect.stringContaining("尚未登录") } }],
    });

    const webhook = sendMilky("米币查询");
    const reply = await milky.next("send_private_message");
    expect(reply.params).toMatchObject({ user_id: 43 });
    expect(JSON.stringify(reply.params)).toContain("当前米游币数量为：520");
    expect(JSON.stringify(reply.params)).toContain("今日剩余可获取：11");
    reply.respond({ message_seq: 601 });
    expect((await webhook).status).toBe(200);

    const failed = await oneBotBalance("#米游币查询3");
    expect(failed.message).toBe("暂时无法读取米游币余额，请稍后重试。");
    expect(await readFile(path(root, "42-3.yaml"), "utf8")).toBe(frozen("42-3.yaml"));
    expect((await oneBotBalance("#米游币查询256")).message).toContain("档案编号须在 1 到 255 之间");

    sendOneBot("#米游币查询4");
    for (let tries = 0; !(await readTrace()).some(row => row.account === "8204"); tries++) {
      if (tries >= 120) throw new Error("隔离接口未收到旧档案的查询");
      await Bun.sleep(10);
    }
    await writeFile(path(root, "42-4.yaml"), Bun.YAML.stringify(profile(42, 4, 8299)), { mode: 0o600 });
    await writeFile(join(root, "balance-release"), "");
    const stale = await onebot.next("send_msg");
    expect(stale.params.message).toBe("档案已变更，请重新查询米游币。");
    stale.respond({ message_id: 502 });

    const calls = await readTrace();
    expect(calls.filter(row => row.account === "8202").map(row => row.kind).sort()).toEqual(["balance", "balance", "cookie_token", "ltoken", "roles"]);
    expect(calls.filter(row => row.account === "8301").map(row => row.kind)).toEqual(["balance"]);
    expect(calls.filter(row => row.account === "8203").map(row => row.kind)).toEqual(["balance"]);
    expect(calls.filter(row => row.account === "8204").map(row => row.kind)).toEqual(["balance"]);
    expect(calls.filter(row => row.method === "POST").map(row => row.kind)).toEqual(["ltoken", "cookie_token"]);
    expect(calls.every(row => ["ltoken", "cookie_token"].includes(row.kind) ? row.method === "POST" :
      row.kind === "roles" ? row.method === undefined : row.kind === "balance" && row.method === "GET")).toBe(true);
    for (const name of ["42.yaml", "43.yaml", "42-3.yaml"]) expect(await readFile(path(root, name), "utf8")).toBe(frozen(name));
    const renewed = await readFile(path(root, "42-2.yaml"), "utf8");
    expect(renewed).toContain("v2_fixture-renewed-cookie_token");
    expect(renewed).toContain("fixture-device-8202");
  }, 5_000, preload, async root => {
    await writeFile(join(root, ".env"), "LOTUS_PROFILE_DIR=fixture-profiles\n");
    await mkdir(join(root, "fixture-profiles"));
    for (const name of initial.keys()) await writeFile(path(root, name), frozen(name), { mode: 0o600 });
  });
}, 16_000);
