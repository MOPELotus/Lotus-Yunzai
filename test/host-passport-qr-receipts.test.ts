import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const preload = `
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
Bun.env.LOTUS_PROFILE_DIR = "./profiles";
Bun.env.LOTUS_PASSPORT_QR_RESOURCES = "./absent-qr-theme";
const original = globalThis.fetch;
const ok = data => Response.json({ retcode: 0, data });
const flows = ["race", "success", "expired", "cancel", "undelivered", "unconfirmed"];
const devices = new Map();
const polls = new Map();
let created = 0, raceRoles = 0;
function trace(...parts) {
  appendFileSync("./requests.jsonl", JSON.stringify(parts) + "\\n");
}
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "127.0.0.1") return original(input, init);
  const headers = new Headers(init?.headers);
  if (url.origin === "https://passport-api.mihoyo.com") {
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(init.proxy, false);
    const device = headers.get("x-rpc-device_id");
    const parsed = JSON.parse(String(init.body));
    const path = url.pathname.split("/").at(-1);
    if (path === "createQRLogin") {
      assert.deepEqual(parsed, {});
      const flow = flows[created++];
      assert.ok(device && flow);
      if (flow === "race") assert.equal(device, "fixture-old-device");
      devices.set(flow, device);
      trace(flow, "create");
      const ticket = "fixture-ticket-" + flow;
      return ok({ ticket, url: "https://user.mihoyo.com/login-platform/mobile.html?tk=" + ticket });
    }
    if (path === "queryQRLoginStatus") {
      const flow = /^fixture-ticket-(.+)$/u.exec(parsed.ticket)?.[1];
      assert.equal(device, devices.get(flow));
      trace(flow, "poll");
      const round = (polls.get(flow) ?? 0) + 1;
      polls.set(flow, round);
      if (flow === "expired") return Response.json({ retcode: "-3501", message: "fixture-secret-message" });
      if (flow === "race" && round <= 2) return ok({ status: "Scanned" });
      const aid = flow === "race" ? "8002" : "8003";
      return ok({ status: "Confirmed", user_info: { aid, mid: "fixture-mid-" + aid },
        tokens: [{ token_type: 1, token: "v2_fixture-stoken-" + aid }] });
    }
    assert.equal(path, "exchange");
    const aid = /^v2_fixture-stoken-(800[23])$/u.exec(parsed.src_token?.token)?.[1];
    const flow = aid === "8002" ? "race" : "success";
    assert.ok(aid);
    assert.equal(parsed.mid, "fixture-mid-" + aid);
    assert.equal(device, devices.get(flow));
    trace(flow, "exchange-" + parsed.dst_token_type);
    return ok({ user_info: { aid }, token: { token: "v2_fixture-" + parsed.dst_token_type + "-" + aid } });
  }
  assert.equal(url.origin, "https://api-takumi.mihoyo.com");
  assert.equal(url.pathname, "/binding/api/getUserGameRolesByCookie");
  const aid = /cookie_token_v2=v2_fixture-4-(800[23])(?:;|$)/u.exec(headers.get("cookie") ?? "")?.[1];
  assert.ok(aid);
  const flow = aid === "8002" ? "race" : "success";
  trace(flow, "roles");
  if (flow === "race") {
    if (++raceRoles === 1) return new Response(null, { status: 410 });
    await Bun.write("./retry-started", "");
    while (!(await Bun.file("./resume-retry").exists())) {
      init.signal.throwIfAborted();
      await Bun.sleep(10);
    }
  }
  return ok({ list: [{ game_biz: "hk4e_cn", game_uid: "1000080" + aid.slice(-2), region: "cn_gf01" }] });
}, { preconnect: original.preconnect });
`;

async function prepare(root: string) {
  await mkdir(join(root, "profiles"));
  const profile = { version: 1, user: { qq: "42" }, profile: { id: 2, name: "本地设置" },
    device: { id: "fixture-old-device", model: "Fixture Device" },
    enabled: false, account: { stuid: "7002", stoken: "v2_fixture-old", mid: "fixture-mid-old",
      cookie: "ltoken_v2=v2_fixture-old-lt;ltuid_v2=7002;ltmid_v2=fixture-mid-old;cookie_token_v2=v2_fixture-old-ct;account_id_v2=7002;account_mid_v2=fixture-mid-old;" },
  };
  await Bun.write(join(root, "profiles/42-2.yaml"), Bun.YAML.stringify(profile));
}

test("实际好友扫码核对换票落盘、过期与取消，已清除档案不发布延迟的成功回执", async () => {
  await withDualGatewayFixture("passport-qr-receipt-fixture", "disablePrivate: false\n", async ({
    root, onebot, milky, sendOneBot, sendMilky,
  }) => {
    function assertReceipt(value: unknown, expected: string) {
      const text = JSON.stringify(value);
      expect(text).toContain(expected);
      expect(text).not.toMatch(/fixture-(?:ticket|stoken|mid|secret)|v2_fixture/u);
    }
    let sequence = 0;
    async function nextOneBot(expected: string, delivery?: "failed" | "unconfirmed") {
      const reply = await onebot.next("send_msg");
      assertReceipt(reply.params, expected);
      reply.respond(delivery === "unconfirmed" ? {} : { message_id: ++sequence }, delivery === "failed" ? "failed" : "ok");
    }
    async function nextMilky(expected: string) {
      const reply = await milky.next("send_private_message");
      assertReceipt(reply.params, expected);
      reply.respond({ message_seq: ++sequence });
    }
    async function read(qq: number, profile: number) {
      return Bun.YAML.parse(await Bun.file(join(root, `profiles/${qq}-${profile}.yaml`)).text());
    }

    sendOneBot("#扫码登录2", { message_type: "group", sub_type: "normal", group_id: 77 });
    await nextOneBot("请私聊发送");
    sendOneBot("#扫码登录2");
    await nextOneBot("创建米游社登录二维码");
    await nextOneBot('"type":"image"');
    sendOneBot("#二维码登录2");
    await nextOneBot("该档案已有二维码");
    await nextOneBot("二维码已扫描");
    const retry = Bun.file(join(root, "retry-started"));
    for (const timeout = Date.now() + 13_000; !await retry.exists();) {
      if (Date.now() >= timeout) throw new Error("未到达角色补查");
      await Bun.sleep(25);
    }
    expect(await read(42, 2)).toMatchObject({ account: { stuid: "8002", ltoken: "v2_fixture-2-8002" } });
    sendOneBot("#清除登录2");
    await nextOneBot("登录信息已清除");
    await Bun.write(join(root, "resume-retry"), "");
    await nextOneBot("档案已变更");
    expect(await read(42, 2)).toMatchObject({
      account: { stuid: "", stoken: "", cookie: "", game_roles: { gs: [] } },
      device: { id: "fixture-old-device" }, profile: { id: 2, name: "本地设置" },
    });

    expect((await sendMilky("#辅助登录3")).status).toBe(200);
    await nextMilky("创建米游社登录二维码");
    await nextMilky('"type":"image"');
    await nextMilky("扫码登录完成");
    expect(await read(43, 3)).toMatchObject({ account: {
      stuid: "8003", stoken: "v2_fixture-stoken-8003", mid: "fixture-mid-8003", ltoken: "v2_fixture-2-8003",
      cookie: expect.stringContaining("cookie_token_v2=v2_fixture-4-8003"),
      game_roles: { gs: [{ uid: "100008003" }] },
    } });

    sendOneBot("#二维码登陆3");
    await nextOneBot("创建米游社登录二维码");
    await nextOneBot('"type":"image"');
    await nextOneBot("登录二维码已过期");
    sendOneBot("#扫码登录4");
    await nextOneBot("创建米游社登录二维码");
    await nextOneBot('"type":"image"');
    expect((await sendMilky("#取消扫码登录4", { sender_id: 42, peer_id: 42 })).status).toBe(200);
    await nextMilky("当前私聊没有该档案的扫码等待");
    sendOneBot("#取消扫码登录4");
    await nextOneBot("已取消扫码登录");
    for (const [id, outcome] of [[5, "failed"], [6, "unconfirmed"]] as const) {
      sendOneBot(`#扫码登录${id}`);
      await nextOneBot("创建米游社登录二维码");
      await nextOneBot('"type":"image"', outcome);
      await Bun.sleep(60);
      sendOneBot(`#取消扫码登录${id}`);
      await nextOneBot("当前私聊没有该档案的扫码等待");
    }
    for (const id of [3, 4, 5, 6]) expect(await Bun.file(join(root, `profiles/42-${id}.yaml`)).exists()).toBe(false);

    const requests = (await Bun.file(join(root, "requests.jsonl")).text()).trim().split("\n")
      .map(line => JSON.parse(line) as unknown);
    expect(requests).toEqual([
      ["race", "create"], ["race", "poll"], ["race", "poll"], ["race", "poll"],
      ["race", "exchange-2"], ["race", "exchange-4"], ["race", "roles"], ["race", "roles"],
      ["success", "create"], ["success", "poll"], ["success", "exchange-2"], ["success", "exchange-4"], ["success", "roles"],
      ["expired", "create"], ["expired", "poll"], ["cancel", "create"], ["undelivered", "create"], ["unconfirmed", "create"],
    ]);
  }, 12_000, preload, prepare);
}, 42_000);
