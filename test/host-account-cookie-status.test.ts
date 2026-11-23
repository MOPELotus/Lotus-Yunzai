import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateInstallation } from "../scripts/migrate.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const users = [42, 43] as const;
const states = ["valid", "renew", "expired", "risk", "transport", "none", "legacy", "exchange-risk", "conflicting"] as const;
const identity = (qq: number, slot: number) => String(900_000_000 + qq * 100 + slot);
const preload = `
Bun.env.LOTUS_PROFILE_DIR = "./migrated/data/users";
import { appendFileSync } from "node:fs";
const fetchImpl = globalThis.fetch;
const states = ${JSON.stringify(states)};
function response(data, init) { return Response.json(data, init); }
function seen(op, aid) {
  appendFileSync("./proof-requests.jsonl", JSON.stringify({ op, aid }) + "\\n");
}
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return fetchImpl(input, init);
  const header = new Headers(init?.headers);
  if (url.origin === "https://api-takumi.mihoyo.com" && url.pathname === "/binding/api/getUserGameRolesByCookie") {
    const cookie = header.get("Cookie") ?? "";
    const aid = /(?:^|;)\\s*(?:account_id|account_id_v2)=([0-9]+)(?:;|$)/u.exec(cookie)?.[1];
    if (!aid || url.search || init?.redirect !== "error") throw new Error("角色请求不是当前档案");
    const state = states[Number(aid) % 100 - 1];
    const renewed = cookie.includes("v2_fresh_cookie_" + aid);
    seen(renewed ? "read-renewed" : "read", aid);
    if (state === "transport") throw new Error("模拟连接失败");
    if (state === "risk") return response({ retcode: -100, message: "访问过于频繁" });
    if (["renew", "expired", "exchange-risk"].includes(state) && !renewed) return response({ retcode: -100 });
    if (!renewed && !cookie.includes("cookie_" + aid)) throw new Error("角色请求 Cookie 不一致");
    return response({ retcode: 0, data: { list: [
      { game_biz: "hk4e_cn", game_uid: String(100_000_000 + Number(aid) % 1000), region: "cn_gf01" },
    ] } });
  }
  if (url.origin === "https://passport-api.mihoyo.com" && url.pathname === "/account/ma-cn-session/app/exchange") {
    const body = JSON.parse(String(init?.body));
    const aid = /^v2_login_([0-9]+)$/u.exec(body.src_token?.token)?.[1];
    if (!aid || header.get("x-rpc-device_id") !== "fixture-device-" + aid || body.mid !== "fixture-mid-" + aid) {
      throw new Error("换票没有绑定自己的档案设备和身份");
    }
    const state = states[Number(aid) % 100 - 1];
    seen("exchange-" + body.dst_token_type, aid);
    if (state === "expired") return response({ retcode: -100, message: "登录已失效" });
    if (state === "exchange-risk") return response({ retcode: -100, message: "验证码，请先完成验证" });
    if (state !== "renew" || ![2,4].includes(body.dst_token_type)) throw new Error("不应换票的档案");
    const token = body.dst_token_type === 2 ? "v2_fresh_ltoken_" : "v2_fresh_cookie_";
    return response({ retcode: 0, data: { token: { token: token + aid }, user_info: { aid } } });
  }
  seen("unexpected", "");
  throw new Error("隔离验收禁止向其它地址请求");
}, { preconnect: fetchImpl.preconnect });
`;

function profile(qq: number, id: number, state: typeof states[number]) {
  const accountId = identity(qq, id);
  const account = state === "none" ? {}
    : state === "legacy" ? { cookie: `ltoken=legacy-${accountId};ltuid=${accountId};cookie_token=cookie_${accountId};account_id=${accountId}` }
      : { stuid: accountId, ltuid: accountId, stoken: `v2_login_${accountId}`, mid: `fixture-mid-${accountId}`,
        cookie: `ltoken_v2=v2_stored_ltoken_${accountId};ltuid_v2=${accountId};ltmid_v2=fixture-mid-${accountId};cookie_token_v2=v2_cookie_${accountId};account_id_v2=${state === "conflicting" ? identity(qq === 42 ? 43 : 42, id) : accountId};account_mid_v2=fixture-mid-${accountId}`,
        stoken_cookie: `stuid=${accountId};stoken=v2_login_${accountId};mid=fixture-mid-${accountId}` };
  return Bun.YAML.stringify({ user: { qq: String(qq) }, profile: { id }, account,
    device: { id: `fixture-device-${accountId}` }, schedule: { mode: "fixed", time: "05:00" } });
}

const name = (qq: number, id: number) => id === 1 ? `${qq}.yaml` : `${qq}-${id}.yaml`;
async function prepare(root: string) {
  const source = join(root, "old");
  const target = join(root, "migrated");
  const plugin = join(source, "plugins/Lotus-ReFactor");
  await mkdir(join(plugin, "data/users"), { recursive: true });
  await mkdir(join(target, "plugins"), { recursive: true });
  await writeFile(join(plugin, "package.json"), '{"name":"lotus-refactor"}');
  await writeFile(join(target, "package.json"), '{"name":"lotus-yunzai"}');
  await writeFile(join(target, "plugins/.fixture"), "fixture");
  for (const qq of users) for (const [index, state] of states.entries()) {
    const id = index + 1;
    await writeFile(join(plugin, "data/users", name(qq, id)), profile(qq, id, state), { mode: 0o600 });
  }
  for (const args of [["init", "-q"], ["add", "package.json", "plugins/.fixture"], ["-c", "core.hooksPath=/dev/null",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
    expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
  }
  expect(await migrateInstallation(source, target)).toMatchObject({ status: "published", archiveCount: 1 });
}

test.skipIf(!Bun.which("git"))("旧档迁移后两套协议只从本人好友私聊逐档检查 Cookie，只有明确失效尝试同档续期", async () => {
  await withDualGatewayFixture("account-cookie-status-fixture", "disablePrivate: false\n", async ({
    root, onebot, milky, sendOneBot, sendMilky,
  }) => {
    const trace = join(root, "proof-requests.jsonl");
    const current = (qq: number, id: number) => join(root, "migrated/data/users", name(qq, id));
    const before = new Map<string, string>();
    for (const qq of users) for (const [index] of states.entries()) {
      const id = index + 1;
      before.set(current(qq, id), await readFile(current(qq, id), "utf8"));
    }
    sendOneBot("#检查CK状态", { message_type: "group", sub_type: "normal", group_id: 770 });
    sendOneBot("#检查Cookie状态", { sub_type: "group" });
    expect((await sendMilky("#CK状态", { message_scene: "group", peer_id: 770 })).status).toBe(200);
    await Bun.sleep(100);
    expect(onebot.calls).toHaveLength(0);
    expect(milky.calls).toHaveLength(0);
    expect(await Bun.file(trace).exists()).toBe(false);

    const checks = [
      "档案 1 · 有效，已通过米游社在线核验",
      "档案 2 · 已自动续期并通过在线核验",
      "档案 3 · 凭据已失效",
      "档案 4 · 暂无法核验",
      "档案 5 · 暂无法核验",
      "档案 6 · 未登录",
      "档案 7 · 有效，仅保存旧 Cookie，不能自动续期",
      "档案 8 · 暂无法核验",
      "档案 9 · 暂无法核验",
      "#UID",
      "#清除登录",
    ];
    function expectStatus(params: object, user_id: number) {
      expect(params).toMatchObject({ user_id });
      const value = JSON.stringify(params);
      for (const line of checks) expect(value).toContain(line);
      expect(value).not.toMatch(/fixture-device|fixture-mid|v2_login|v2_cookie|aid|频繁|验证码/u);
    }
    sendOneBot("#检查CK状态");
    const own = await onebot.next("send_msg");
    expectStatus(own.params, 42);
    own.respond({ message_id: 901 });
    expect((await sendMilky("#我的cookie状态")).status).toBe(200);
    const friend = await milky.next("send_private_message");
    expectStatus(friend.params, 43);
    friend.respond({ message_seq: 902 });

    for (const qq of users) for (const [index, state] of states.entries()) {
      const id = index + 1;
      const file = current(qq, id);
      const bytes = await readFile(file, "utf8");
      if (state === "renew") {
        expect(bytes).toContain("v2_fresh_cookie_" + identity(qq, id));
        expect(bytes).toContain("v2_login_" + identity(qq, id));
      } else {
        expect(bytes).toBe(before.get(file)!);
      }
      expect(await readFile(join(root, "old/plugins/Lotus-ReFactor/data/users", name(qq, id)), "utf8")).toBe(profile(qq, id, state));
    }
    const accesses = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { op: string; aid: string });
    expect(accesses.some(row => row.op === "unexpected")).toBe(false);
    for (const qq of users) {
      const forSlot = (id: number) => accesses.filter(row => row.aid === identity(qq, id)).map(row => row.op);
      expect(forSlot(1)).toEqual(["read"]);
      expect(forSlot(2)).toEqual(["read", "exchange-2", "exchange-4", "read-renewed", "read-renewed"]);
      expect(forSlot(3)).toEqual(["read", "exchange-2"]);
      expect(forSlot(4)).toEqual(["read"]);
      expect(forSlot(5)).toEqual(["read"]);
      expect(forSlot(6)).toEqual([]);
      expect(forSlot(7)).toEqual(["read"]);
      expect(forSlot(8)).toEqual(["read", "exchange-2"]);
      expect(forSlot(9)).toEqual([]);
    }
  }, 6_000, preload, prepare);
}, 25_000);
