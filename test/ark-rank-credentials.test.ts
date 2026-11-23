import { expect, test } from "bun:test";
import { arkRankCredentialsPath, arkRankTokenKey, containsArkRankTokenInput, createArkRankCredentialSettings,
  isArkRankTokenCommand } from "../lib/ark-rank-credentials.ts";
import type { MessageFallbackContext } from "../lib/commands.ts";
import { panelApi } from "../lib/panel.ts";
import type { RankStatsTransport } from "../lib/rank-statistics.ts";
import { withDualGatewayFixture } from "./host-dual-gateway-fixture.ts";

const oldToken = "OLD-ARK-fixture-101";
const newToken = "NEW-ARK-fixture-102";
const environmentToken = "ENV-ARK-fixture-103";

test("带称呼与分段的凭据输入也不进入群通知", () => {
  expect(containsArkRankTokenInput("机器人 ＃ark配置token临时样本")).toBe(true);
  expect(containsArkRankTokenInput([{ type: "text", text: "井设置排行" }, { type: "text", text: "凭据 样本" }])).toBe(true);
  expect(containsArkRankTokenInput("#排行凭据 状态")).toBe(false);
});

test("宿主拦截旧凭据命令，群聊和其他成员无法使用已绑定的主人权限", async () => {
  await withDualGatewayFixture("ark-credentials-fixture", 'master: ["99:42"]\ndisablePrivate: true\n',
    async ({ onebot, sendOneBot }) => {
      sendOneBot(`#ark配置token${newToken}`);
      const accepted = await onebot.next("send_msg");
      expect(accepted.params).toMatchObject({ user_id: 42, message: expect.stringContaining("由环境变量") });
      expect(JSON.stringify(accepted.params)).not.toContain(newToken);
      accepted.respond({ message_id: 11 });

      sendOneBot(`#设置排行凭据 ${newToken}`, { message_type: "group", sub_type: "normal", group_id: 77 });
      const group = await onebot.next("send_msg");
      expect(group.params).toMatchObject({ group_id: 77, message: expect.stringContaining("已绑定的好友私聊") });
      expect(JSON.stringify(group.params)).not.toContain(newToken);
      group.respond({ message_id: 12 });

      sendOneBot("#排行凭据 状态", { user_id: 43 });
      const outsider = await onebot.next("send_msg");
      expect(outsider.params).toMatchObject({ user_id: 43, message: expect.stringContaining("已绑定的好友私聊") });
      outsider.respond({ message_id: 13 });
    }, 4_000, `Bun.env.LOTUS_ARK_CUSTOM_RANK_TOKEN = ${JSON.stringify(environmentToken)};`);
}, 15_000);

function fixture(transport?: RankStatsTransport) {
  let token: string | undefined = oldToken;
  function verifyKey(key: string) { expect(key).toBe(arkRankTokenKey); }
  const operations = { reads: 0, sets: 0, clears: 0 };
  const runtime: { environment?: string; available: boolean; fail: boolean } = { available: true, fail: false };
  const storage = {
    async get(key: string) {
      verifyKey(key);
      operations.reads++;
      if (runtime.fail) throw new Error(token);
      return token;
    },
    async set(key: string, value: string) {
      verifyKey(key);
      operations.sets++;
      if (runtime.fail) throw new Error(value);
      token = value;
      return "OK";
    },
    async del(key: string) {
      verifyKey(key);
      operations.clears++;
      const before = token;
      token = undefined;
      return before === undefined ? 0 : 1;
    },
  };
  const signal = new AbortController();
  const settings = createArkRankCredentialSettings({
    signal: signal.signal, storage: () => runtime.available ? storage : undefined, environment: () => runtime.environment, transport,
  });
  return { ...settings, operations, runtime, current: () => token, signal };
}

test("宿主让当前主人查询分档额度，拒绝群和其他好友访问用量", async () => {
  const preload = `
    Bun.env.LOTUS_ARK_CUSTOM_RANK_TOKEN = ${JSON.stringify(environmentToken)};
    const underlying = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === "127.0.0.1") return underlying(input, init);
      if (url.href !== "https://ark.ivny.cn/auth/usage") throw new Error("unexpected external request");
      calls++;
      if (calls !== 1 || init?.method !== "POST" || init?.redirect !== "error" ||
          init?.credentials !== "omit" || new Headers(init?.headers).get("authorization") !== "Bearer " + Bun.env.LOTUS_ARK_CUSTOM_RANK_TOKEN ||
          JSON.stringify(JSON.parse(init?.body)) !== '{"version":"2.1.0"}') return new Response(null, { status: 400 });
      return Response.json({ retcode: 0, data: {
        auth: { permission: 1, limit_normal: 2.5, token: Bun.env.LOTUS_ARK_CUSTOM_RANK_TOKEN },
        quota: { rank: { minute: { remaining: 0 }, hour: { remaining: 10 }, day: { remaining: 900 } },
          custom: { normal: { remaining: 12 }, advanced: { remaining: 3 } } },
      } });
    };
  `;
  await withDualGatewayFixture("ark-usage-fixture", 'master: ["99:42"]\ndisablePrivate: true\n',
    async ({ onebot, sendOneBot }) => {
      sendOneBot("#排行凭据 用量", { message_type: "group", sub_type: "normal", group_id: 77 });
      const group = await onebot.next("send_msg");
      expect(group.params).toMatchObject({ group_id: 77, message: expect.stringContaining("好友私聊") });
      group.respond({ message_id: 12 });
      sendOneBot("#排行用量", { user_id: 43 });
      const outsider = await onebot.next("send_msg");
      expect(outsider.params).toMatchObject({ user_id: 43, message: expect.stringContaining("好友私聊") });
      outsider.respond({ message_id: 13 });
      sendOneBot("#排行凭据 用量");
      const allowed = await onebot.next("send_msg");
      expect(allowed.params).toMatchObject({ user_id: 42, message: [
        "凭据权限：高级", "全部请求剩余（分钟／小时／天）：0／10／900", "自定义排行普通请求倍率：2.5 倍",
        "自定义排行普通请求剩余：12", "自定义排行高级请求剩余：3",
      ].join("\n") });
      expect(JSON.stringify(allowed.params)).not.toContain(environmentToken);
      allowed.respond({ message_id: 14 });
    }, 4_000, preload);
}, 15_000);

test("排行用量覆盖缺失凭据、服务失败、部分字段及权限变化，所有回复均无回包中的秘密", async () => {
  const blocked = Promise.withResolvers<Response>();
  const entered = Promise.withResolvers<void>();
  const responses: Array<Response | Promise<Response>> = [
    Response.json({ retcode: 401, message: oldToken }),
    Response.json({ retcode: 0, data: { auth: { permission: 0, limit_normal: oldToken },
      quota: { rank: { hour: { remaining: "12" }, day: { remaining: -10 } }, custom: { normal: { remaining: oldToken } } } } }),
    new Response(null, { status: 429 }),
    blocked.promise,
  ];
  const calls: RequestInit[] = [];
  const { command, operations, runtime } = fixture(async (url, init) => {
    expect(url).toBe("https://ark.ivny.cn/auth/usage");
    expect(init.body).toBe('{"version":"2.1.0"}');
    calls.push(init);
    if (calls.length === 4) entered.resolve();
    return responses.shift()!;
  });
  let currentOwner = true;
  const scope: MessageFallbackContext = {
    normalizedMessage: "#排行用量", raw_message: "#排行用量", message_type: "private", self_id: 99, user_id: 42,
    isMaster: true, isFriend: async () => true, isBotMaster: () => currentOwner,
    privateCredentialSignal: new AbortController().signal, reply: () => true,
  };
  const issue = (message = "#排行用量") => command(message, scope);
  runtime.environment = "";
  expect(await issue()).toContain("格式无效");
  expect(calls).toHaveLength(0);
  expect(operations.reads).toBe(0);
  runtime.environment = undefined;
  expect(await issue()).toBe("暂时无法查询排行凭据用量，请检查凭据后重试。");
  expect(new Headers(calls[0]!.headers).get("authorization")).toBe("Bearer " + oldToken);

  runtime.environment = environmentToken;
  expect(await issue()).toBe([
    "凭据权限：普通", "全部请求剩余（分钟／小时／天）：—／12／—", "自定义排行普通请求倍率：1 倍",
    "自定义排行普通请求剩余：—", "自定义排行高级请求剩余：—",
  ].join("\n"));
  expect(new Headers(calls[1]!.headers).get("authorization")).toBe("Bearer " + environmentToken);
  expect(await issue()).toContain("过于频繁");
  expect(operations.reads).toBe(1);

  const pending = issue();
  await entered.promise;
  currentOwner = false;
  blocked.resolve(Response.json({ retcode: 0, data: { auth: { permission: 1 } } }));
  expect(await pending).toBeUndefined();
  currentOwner = true;

  runtime.environment = undefined;
  expect(await issue("#排行凭据 清除")).toContain("已清除");
  expect(await issue()).toBe("尚未设置排行榜 Token。");
  expect(calls).toHaveLength(4);
  expect(isArkRankTokenCommand("#arktoken用量")).toBe(false);
  expect(containsArkRankTokenInput("#排行凭据 用量")).toBe(false);
});

function panelRequest(method = "GET", body?: unknown, authorized = true) {
  return new Request("https://panel.example.invalid" + arkRankCredentialsPath, {
    method, headers: {
      ...(authorized ? { Authorization: "Bearer admin-fixture" } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("管理面板可替换和清除旧排行凭据，响应及错误不返回旧、新或环境值", async () => {
  const { panel, operations, runtime, current } = fixture();
  const receive = panelApi("admin-fixture", [], path => path === arkRankCredentialsPath ? panel : undefined);
  async function read(request: Request, status = 200) {
    const response = (await receive(request))!;
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    for (const secret of [oldToken, newToken, environmentToken]) expect(body).not.toContain(secret);
    return body ? JSON.parse(body) : undefined;
  }
  await read(panelRequest("PUT", { token: newToken }, false), 401);
  expect(operations.sets).toBe(0);
  expect(await read(panelRequest())).toEqual({ source: "stored", usable: true });
  await read(panelRequest("PUT", { token: "bad token" }), 400);
  await read(panelRequest("PUT", { token: newToken, spare: oldToken }), 400);
  expect(await read(panelRequest("PUT", { token: newToken }))).toEqual({ source: "stored", usable: true });
  expect(current()).toBe(newToken);

  runtime.environment = environmentToken;
  expect(await read(panelRequest())).toEqual({ source: "environment", usable: true });
  expect(await read(panelRequest("DELETE"), 409)).toMatchObject({ message: expect.stringContaining("LOTUS_ARK_CUSTOM_RANK_TOKEN") });
  runtime.environment = "";
  expect(await read(panelRequest())).toEqual({ source: "environment", usable: false });
  expect(current()).toBe(newToken);
  expect(operations.clears).toBe(0);

  runtime.environment = undefined;
  runtime.fail = true;
  await read(panelRequest("PUT", { token: newToken }), 503);
  await read(panelRequest(), 503);
  runtime.fail = false;
  expect(await read(panelRequest("DELETE"))).toEqual({ source: "none", usable: false });
  expect(current()).toBeUndefined();
  expect(await read(panelRequest("DELETE"))).toEqual({ source: "none", usable: false });
  runtime.available = false;
  await read(panelRequest(), 503);
});

test("旧粘连指令和新命令只允许当前主人好友私聊，权限变化不提交", async () => {
  const { command, operations, current, runtime } = fixture();
  const connection = new AbortController();
  const set = "#Ark配置token" + newToken;
  let owner = true;
  const scope: MessageFallbackContext = {
    normalizedMessage: set, raw_message: set, message_type: "private", self_id: 99, user_id: 42,
    isMaster: true, isFriend: async () => true, isBotMaster: () => owner, privateCredentialSignal: connection.signal,
    reply: () => true,
  };
  function issue(message: string, override: Partial<MessageFallbackContext> = {}) {
    expect(isArkRankTokenCommand(message)).toBe(true);
    return command(message, { ...scope, normalizedMessage: message, ...override });
  }
  for (const blocked of [
    { message_type: "group" as const }, { message_type: "terminal" as const },
    { isMaster: false }, { isDelegated: true as const }, { privateCredentialSignal: undefined },
  ]) {
    expect(await issue(set, blocked)).toContain("好友私聊");
  }
  expect(await issue(set, { isFriend: async () => false })).toContain("无法确认");
  expect(operations.sets).toBe(0);
  const verified = Promise.withResolvers<boolean>();
  const pending = issue(set, { isFriend: () => verified.promise });
  owner = false;
  verified.resolve(true);
  expect(await pending).toBeUndefined();
  expect(operations.sets).toBe(0);

  owner = true;
  expect(await issue(set)).toBe("排行榜 Token 已保存。");
  expect(current()).toBe(newToken);
  expect(await issue("＃排行凭据状态")).toBe("已保存排行榜 Token。");
  runtime.environment = environmentToken;
  expect(await issue("#排行凭据 清除")).toContain("LOTUS_ARK_CUSTOM_RANK_TOKEN");
  expect(operations.clears).toBe(0);
  runtime.environment = undefined;
  expect(await issue("#排行凭据 清除")).toBe("排行榜 Token 已清除。");
  expect(current()).toBeUndefined();
  connection.abort();
  expect(await issue(set)).toContain("好友私聊");
  expect(operations.sets).toBe(1);
});

test("面板收取请求体时失去管理权限则不会提交 Token", async () => {
  const { panel, operations } = fixture();
  let authorized = true;
  const request = new Request("https://panel.example.invalid" + arkRankCredentialsPath, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: new ReadableStream<Uint8Array>({ start(controller) {
      queueMicrotask(() => {
        authorized = false;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ token: newToken })));
        controller.close();
      });
    } }),
  });
  const response = await panel(request, () => authorized);
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("");
  expect(operations.sets).toBe(0);
});
