import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { isPassportLoginInput, passportLoginCommands } from "../lib/passport-login.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

test("旧米游社登录紧连凭据仍由登录入口处理，合法档号保留扫码", async () => {
  const command = passportLoginCommands(undefined, new AbortController().signal).fallback!;
  const context = { user_id: 42, self_id: 51, message_type: "group", isMaster: false,
    isBotMaster: () => false, reply: async () => true } as const;
  for (const normalizedMessage of ["#米游社登录fixture-password", "登录米游社 fixture-password", "#账号密码登录fixture-password"]) {
    expect(isPassportLoginInput(normalizedMessage)).toBe(true);
    expect(await command("", { ...context, normalizedMessage })).toBe("请使用 #扫码登录，账号密码登录已停用。");
  }
  expect(await command("", { ...context, normalizedMessage: "#米游社登录2" })).toBe("请在机器人所在群聊或好友私聊中发送 #扫码登录2。");
});

test("两协议宿主直接处理旧的紧连登录写法，只回复扫码入口", async () => {
  const message = "#米游社登录fixture-password";
  const response = "请使用 #扫码登录，账号密码登录已停用。";
  await withDualGatewayFixture("passport-compact", 'master: ["99:91", "100:92"]\n', async gateway => {
    gateway.sendOneBot(message);
    const onebot = await gateway.onebot.next("send_msg");
    expect(onebot.params.message).toBe(response);
    onebot.respond({ message_id: 100 });
    expect((await gateway.sendMilky(message)).status).toBe(200);
    const milky = await gateway.milky.next("send_private_message");
    expect(milky.params.message).toEqual([{ type: "text", data: { text: response } }]);
    milky.respond({ message_seq: 101 });
  });
});

test("扫码入口拒绝无活动会话，断开会取消尚在创建的二维码", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-passport-command-"));
  const originalFetch = globalThis.fetch;
  try {
    const requests: AbortSignal[] = [];
    const started = Promise.withResolvers<void>();
    globalThis.fetch = (async (url, init) => {
      expect(new URL(String(url)).pathname.endsWith("/createQRLogin")).toBe(true);
      const signal = init?.signal;
      if (!signal) throw new Error("扫码请求缺少会话信号");
      requests.push(signal);
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const fallback = passportLoginCommands(root, new AbortController().signal).fallback!;
    const messages: unknown[] = [];
    const context = { user_id: 42, self_id: 51, message_type: "private", isMaster: false,
      normalizedMessage: "#扫码登录2", isBotMaster: () => false,
      reply: async (reply: unknown) => { messages.push(reply); return true; } } as const;
    const closed = AbortSignal.abort();
    expect(await fallback("", context)).toContain("当前连接");
    expect(await fallback("", { ...context, privateCredentialSignal: closed })).toContain("当前连接");
    expect(await fallback("", { ...context, message_type: "terminal" })).toContain("群聊或好友私聊");
    expect(requests).toHaveLength(0);
    const connection = new AbortController();
    const pending = fallback("", { ...context, privateCredentialSignal: connection.signal });
    await started.promise;
    connection.abort();
    expect(await pending).toEqual([]);
    expect(requests.every(signal => signal.aborted)).toBe(true);
    expect(messages).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("二维码送达后扫描提醒被拒仍可确认登录，档案填入可信好友昵称", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-passport-scan-notice-"));
  const originalFetch = globalThis.fetch;
  const profiles = createProfileStore(root);
  const notices: string[] = [];
  const ticket = "fixture-scan-notice-ticket";
  const aid = "8001";
  let polls = 0;
  try {
    await writeFile(join(root, "42-2.yaml"), "user: { qq: '42' }\nprofile: { id: 2 }\ndevice: { id: fixture-bound-device }\n");
    globalThis.fetch = (async (url, init) => {
      const { pathname } = new URL(String(url));
      const ok = (data: unknown) => Response.json({ retcode: 0, data });
      if (pathname.endsWith("/createQRLogin")) {
        expect(new Headers(init?.headers).get("x-rpc-device_id")).toBe("fixture-bound-device");
        return ok({ ticket, url: `https://user.mihoyo.com/login-platform/mobile.html?tk=${ticket}` });
      }
      if (pathname.endsWith("/queryQRLoginStatus")) {
        polls++;
        return polls < 3 ? ok({ status: "Scanned" }) : ok({ status: "Confirmed", user_info: { aid, mid: "fixture-mid" },
          tokens: [{ token_type: 1, token: "v2_fixture-stoken" }] });
      }
      if (pathname.endsWith("/exchange")) {
        const { dst_token_type } = JSON.parse(String(init?.body));
        return ok({ aid, token: { token: `v2_fixture-${dst_token_type}` } });
      }
      expect(pathname).toBe("/binding/api/getUserGameRolesByCookie");
      return ok({ list: [{ game_biz: "hk4e_cn", game_uid: "100000001", region: "cn_gf01" }] });
    }) as typeof fetch;
    const fallback = passportLoginCommands(root, new AbortController().signal).fallback!;
    const result = await fallback("#扫码登录2", {
      user_id: 42, self_id: 51, message_type: "private", sub_type: "friend", isMaster: false,
      normalizedMessage: "#扫码登录2", isBotMaster: () => false, sender: { user_id: 42, nickname: "档案昵称\u0000 " },
      privateCredentialSignal: new AbortController().signal,
      async reply(message, _quote, options) {
        if (typeof message === "string" && message.startsWith("二维码已扫描")) {
          notices.push(message);
          return false;
        }
        await options?.onDelivered?.(1);
        return true;
      },
    });
    expect(result).toContain("扫码登录完成");
    expect(polls).toBe(3);
    expect(notices).toHaveLength(1);
    expect(await profiles.describe("42", 2)).toMatchObject({ loggedIn: true, nickname: "档案昵称", activeRoles: { gs: "100000001" } });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
}, 23_000);

for (const failure of ["expired", "temporary"] as const) {
  test(`扫码已保存后重试角色同步（${failure}），补位沿用保存后的档案`, async () => {
    const root = await mkdtemp(join(tmpdir(), "lotus-passport-post-login-"));
    const originalFetch = globalThis.fetch;
    const profiles = createProfileStore(root);
    const cookieHeaders: (string | null)[] = [];
    let exchanges = 0;
    let scheduled = 0;
    const aid = "8001";
    const ticket = "fixture-passport-ticket";
    try {
      globalThis.fetch = (async (url, init) => {
        const { pathname } = new URL(String(url));
        const ok = (data: unknown) => Response.json({ retcode: 0, data });
        if (pathname.endsWith("/createQRLogin")) return ok({
          ticket, url: `https://user.mihoyo.com/login-platform/mobile.html?tk=${ticket}`,
        });
        if (pathname.endsWith("/queryQRLoginStatus")) return ok({
          status: "Confirmed", user_info: { aid, mid: "fixture-mid" },
          tokens: [{ token_type: 1, token: "v2_fixture-stoken" }],
        });
        if (pathname.endsWith("/exchange")) {
          const { dst_token_type } = JSON.parse(String(init?.body));
          exchanges++;
          return ok({ aid, token: { token: `v2_fixture-${dst_token_type}-${exchanges}` } });
        }
        expect(pathname).toBe("/binding/api/getUserGameRolesByCookie");
        cookieHeaders.push(new Headers(init?.headers).get("Cookie"));
        if (cookieHeaders.length === 1) {
          return failure === "expired" ? Response.json({ retcode: -100 }) : new Response(null, { status: 410 });
        }
        // The retry runs with the original confirmed login already persisted.
        expect((await profiles.accountContext("42", 2)).account.stoken).toBe("v2_fixture-stoken");
        return ok({ list: [{ game_biz: "hk4e_cn", game_uid: "100000001", region: "cn_gf01", nickname: "Fixture" }] });
      }) as typeof fetch;
      const fallback = passportLoginCommands(root, new AbortController().signal, async (qq, id, revision) => {
        const current = await profiles.accountContext(qq, id);
        expect([qq, id, current.revision]).toEqual(["42", 2, revision]);
        scheduled++;
      }).fallback!;
      const reply = await fallback("", {
        user_id: 42, self_id: 51, message_type: "private", isMaster: false, normalizedMessage: "#扫码登录2",
        isBotMaster: () => false, privateCredentialSignal: new AbortController().signal,
        async reply(_message, _quote, options) {
          await options?.onDelivered?.(1);
          return true;
        },
      });
      expect(reply).toContain("扫码登录完成");
      expect(scheduled).toBe(1);
      expect(exchanges).toBe(failure === "expired" ? 4 : 2);
      expect(cookieHeaders).toHaveLength(2);
      expect(cookieHeaders[1]).toContain(failure === "expired" ? "cookie_token_v2=v2_fixture-4-4" : "cookie_token_v2=v2_fixture-4-2");
      expect((await profiles.describe("42", 2)).roles.gs.map(role => role.uid)).toEqual(["100000001"]);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  }, 12_000);
}

test("群扫码会话绑定原群，其他群不能取消，断线不落盘", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-passport-group-"));
  const originalFetch = globalThis.fetch;
  const started = Promise.withResolvers<void>();
  const connection = new AbortController();
  try {
    globalThis.fetch = (async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("missing signal");
      started.resolve();
      return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }) as typeof fetch;
    const fallback = passportLoginCommands(root, new AbortController().signal).fallback!;
    const context = { user_id: 42, self_id: 51, group_id: 61, message_id: 10, message_type: "group", groupActivitySignal: connection.signal,
      normalizedMessage: "#扫码登录2", isMaster: false, isBotMaster: () => false, reply: async () => true } as const;
    const pending = fallback("", context);
    await started.promise;
    const other = await fallback("", { ...context, group_id: 62, normalizedMessage: "#取消扫码登录2" });
    expect(other).toBeDefined();
    expect(connection.signal.aborted).toBe(false);
    const cancelled = await fallback("", { ...context, normalizedMessage: "#取消扫码登录2" });
    expect(cancelled).toBeDefined();
    expect(await pending).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  } finally {
    connection.abort();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
