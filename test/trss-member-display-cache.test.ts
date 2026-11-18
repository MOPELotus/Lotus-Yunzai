import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOneBot } from "../lib/adapters/onebot.ts";
import { OneBotGroups } from "../lib/adapters/onebot-groups.ts";
import { copyHost } from "./host-fixture.ts";

interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: Readonly<Record<string, unknown>>;
}

const token = "member-display-fixture";
const groupId = 70001;
const joinedGroup = 70002;

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 2_500);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function connect(endpoint: string, botId: number) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(endpoint, {
    headers: { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": String(botId) },
  });
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
  const frames: Frame[] = [];
  let frameReady = Promise.withResolvers<void>();
  socket.addEventListener("message", ({ data }) => {
    frames.push(JSON.parse(data));
    frameReady.resolve();
  });
  try {
    await deadline(new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    }), "模拟网关连接超时。");
  } catch (error) {
    socket.close();
    throw error;
  }

  function send(payload: object) {
    socket.send(JSON.stringify({ self_id: botId, ...payload }));
  }

  return {
    send,
    closed,
    close: () => socket.close(),
    assertNoPendingFrames: () => expect(frames).toEqual([]),
    async take(action: string, params: object) {
      if (!frames.length) await deadline(frameReady.promise, `没有收到 OneBot 动作 ${action}。`);
      const frame = frames.shift()!;
      if (!frames.length) frameReady = Promise.withResolvers<void>();
      expect(frame).toMatchObject({ action, params });
      return frame;
    },
    receipt(frame: Frame, data?: unknown) {
      expect(frame.echo).toBeDefined();
      send({ echo: frame.echo, status: "ok", retcode: 0, data });
    },
  };
}

type Gateway = Awaited<ReturnType<typeof connect>>;

async function endpointOf(host: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const reader = host.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) throw new Error("测试宿主未启动 OneBot 入口。");
      output += decoder.decode(part.value, { stream: true });
      const endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      if (endpoint) return endpoint;
    }
  } finally {
    reader.releaseLock();
  }
}

async function withHost(cache: false | undefined, run: (connectGateway: (botId: number) => Promise<Gateway>) => Promise<void>,
  autoQuit?: number,
) {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-member-display-"));
  const gateways: Gateway[] = [];
  try {
    await copyHost(root);
    if (cache === false) {
      await mkdir(join(root, "config"), { recursive: true });
      await writeFile(join(root, "config", "bot.yaml"), "cache_group_member: false\n");
    }
    if (autoQuit !== undefined) {
      await mkdir(join(root, "config"), { recursive: true });
      await writeFile(join(root, "config", "other.yaml"), `autoQuit: ${autoQuit}\n`);
    }
    await writeFile(join(root, "plugins", "member-display-fixture.js"), `
      export const apps = {
        departure: class extends plugin {
          constructor() { super({ event: "notice.group.decrease" }); }
          async accept(e) {
            await e.reply(JSON.stringify({
              user: e.user_id, card: e.member?.card ?? null,
              nickname: e.member?.nickname ?? e.nickname ?? null,
            }));
            return "return";
          }
        },
        join: class extends plugin {
          constructor() { super({ event: "notice.group.increase" }); }
          async accept(e) {
            if (e.user_id !== e.self_id || e.group_id !== ${joinedGroup}) return false;
            await e.reply("已处理进群");
            return "return";
          }
        },
        message: class extends plugin {
          constructor() {
            super({ event: "message.group", rule: [
              { reg: "^#缓存探针$", fnc: "probe" },
              { reg: "^#管理探针$", fnc: "probe", permission: "admin" },
            ] });
          }
          probe(e) { return e.reply("已处理群消息"); }
        },
        authorization: class extends plugin {
          constructor() {
            super({ event: "message.private", rule: [{ reg: "^#核验群权限$", fnc: "check" }] });
          }
          async check(e) { return e.reply("群角色 " + await e.getGroupRole(${groupId})); }
        },
      };
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const endpoint = await deadline(endpointOf(host), "测试宿主启动超时。");
      await run(async (botId) => {
        const gateway = await connect(endpoint, botId);
        gateways.push(gateway);
        return gateway;
      });
      host.kill();
      await deadline(host.exited, "测试宿主退出超时。");
      for (const gateway of gateways) {
        await deadline(gateway.closed, "测试网关断开超时。");
        gateway.assertNoPendingFrames();
      }
      expect(await stderr).not.toContain("处理 OneBot 来信失败");
    } finally {
      for (const gateway of gateways) gateway.close();
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function groupMessage(gateway: Gateway, user: number, message: string, sender: object) {
  gateway.send({
    post_type: "message", message_type: "group", sub_type: "normal", group_id: groupId,
    user_id: user, message, sender,
  });
}

async function depart(
  gateway: Gateway, group: number, user: number, card: string | null, nickname: string | null,
  member?: { card: string; nickname: string },
) {
  gateway.send({
    post_type: "notice", notice_type: "group_decrease", sub_type: "leave", group_id: group, user_id: user, member,
  });
  const reply = await gateway.take("send_msg", { group_id: group, message: JSON.stringify({ user, card, nickname }) });
  gateway.receipt(reply);
}

async function joinGroup(gateway: Gateway, botId: number) {
  gateway.send({
    post_type: "notice", notice_type: "group_increase", sub_type: "invite", group_id: joinedGroup,
    user_id: botId, time: 1_700_000_000,
  });
  const reply = await gateway.take("send_msg", { group_id: joinedGroup, message: "已处理进群" });
  gateway.receipt(reply);
}

test("cache_group_member 默认预热显示名，跟随群事件更新并按机器人连接隔离", async () => {
  await withHost(undefined, async (connectGateway) => {
    const first = await connectGateway(99);
    first.receipt(await first.take("get_group_list", {}), [{ group_id: groupId }]);
    first.receipt(await first.take("get_group_member_list", { group_id: groupId }), [
      { group_id: groupId, user_id: 42, nickname: "旧昵称", card: "旧名片", role: "owner" },
      { group_id: groupId, user_id: 43, nickname: "第二位昵称", card: "第二位旧名片" },
      { group_id: groupId, user_id: 44, nickname: "旧连接昵称" },
      { group_id: groupId, user_id: 45, nickname: "仅昵称" },
      { group_id: groupId, user_id: 47, nickname: "第一个帐号昵称" },
      { group_id: groupId, user_id: 48, nickname: "退群前昵称", card: "退群前名片" },
    ]);

    first.send({
      post_type: "message", message_type: "private", sub_type: "friend", user_id: 42, message: "#核验群权限",
    });
    first.receipt(await first.take("get_group_member_info", {
      group_id: groupId, user_id: 42, no_cache: true,
    }), { group_id: groupId, user_id: 42, role: "member" });
    await first.take("send_msg", { user_id: 42, message: "群角色 member" });

    groupMessage(first, 42, "#管理探针", { role: "member" });
    await first.take("send_msg", { group_id: groupId, message: "暂无权限执行此指令。" });
    groupMessage(first, 42, "#缓存探针", { card: "消息名片", nickname: "消息昵称", role: "member" });
    await first.take("send_msg", { group_id: groupId, message: "已处理群消息" });
    first.send({
      post_type: "notice", notice_type: "group_card", group_id: groupId,
      user_id: 43, card_old: "第二位旧名片", card_new: "新群名片",
    });
    await depart(first, groupId, 42, "消息名片", "消息昵称");
    await depart(first, groupId, 43, "新群名片", "第二位昵称");
    await depart(first, groupId, 45, null, "仅昵称");
    await depart(first, groupId, 45, null, null);
    await depart(first, groupId, 48, "通知名片", "通知昵称", { card: "通知名片", nickname: "通知昵称" });

    const second = await connectGateway(100);
    second.receipt(await second.take("get_group_list", {}), [{ group_id: groupId }]);
    second.receipt(await second.take("get_group_member_list", { group_id: groupId }), [
      { group_id: groupId, user_id: 47, nickname: "第二个帐号昵称" },
    ]);
    await depart(second, groupId, 47, null, "第二个帐号昵称");
    await depart(first, groupId, 47, null, "第一个帐号昵称");

    await joinGroup(first, 99);
    first.receipt(await first.take("get_group_member_list", { group_id: joinedGroup }), [
      { group_id: joinedGroup, user_id: 46, card: "刚进群的名片" },
    ]);
    await depart(first, joinedGroup, 46, "刚进群的名片", null);

    const replacement = await connectGateway(99);
    replacement.receipt(await replacement.take("get_group_list", {}), []);
    await depart(replacement, groupId, 44, null, null);
  });
}, 15_000);

test("cache_group_member 显式关闭时跳过预热，仍能使用群事件时观察到的显示名", async () => {
  await withHost(false, async (connectGateway) => {
    const gateway = await connectGateway(99);
    groupMessage(gateway, 42, "#缓存探针", { card: "消息名片", nickname: "消息昵称", role: "member" });
    await gateway.take("send_msg", { group_id: groupId, message: "已处理群消息" });
    await depart(gateway, groupId, 42, "消息名片", "消息昵称");
    await joinGroup(gateway, 99);
    await depart(gateway, joinedGroup, 42, null, null);
  });
}, 10_000);

test("同账号跨监听口重连取消旧缓存预热，旧连接仍能处理 OneBot 消息", async () => {
  const groups = new OneBotGroups();
  function listener() {
    return startOneBot(async (event) => {
      if (event.post_type === "notice" && event.notice_type === "group" && event.sub_type === "decrease") {
        await event.reply(JSON.stringify({
          user: event.user_id, card: event.member?.card ?? null, nickname: event.member?.nickname ?? null,
        }));
      }
    }, {
      hostname: "127.0.0.1", port: 0, groups, prewarmGroupMembers: true,
      auth: new Headers({ Authorization: `Bearer ${token}` }), isMaster: () => false, masterIds: () => [],
    });
  }
  const servers = [listener(), listener()];
  const gateways: Gateway[] = [];
  async function connectTo(server: ReturnType<typeof listener>) {
    const endpoint = new URL("/OneBotv11", server.url);
    endpoint.protocol = "ws:";
    const gateway = await connect(endpoint.href, 99);
    gateways.push(gateway);
    return gateway;
  }

  try {
    const old = await connectTo(servers[0]!);
    old.receipt(await old.take("get_group_list", {}), [{ group_id: groupId }, { group_id: joinedGroup }]);
    const stale = await old.take("get_group_member_list", { group_id: groupId });

    const current = await connectTo(servers[1]!);
    current.receipt(await current.take("get_group_list", {}), [{ group_id: groupId }]);
    current.receipt(await current.take("get_group_member_list", { group_id: groupId }), [
      { group_id: groupId, user_id: 42, nickname: "新连接昵称" },
    ]);
    old.receipt(stale, [{ group_id: groupId, user_id: 42, nickname: "旧连接昵称" }]);
    await depart(current, groupId, 42, null, "新连接昵称");
    await depart(old, groupId, 42, null, null);
    old.assertNoPendingFrames();
    old.close();
    await deadline(old.closed, "旧网关未关闭。");

    const outbound = groups.listGroups(99);
    current.receipt(await current.take("get_group_list", {}), []);
    expect(await outbound).toEqual([]);
  } finally {
    for (const gateway of gateways) gateway.close();
    await Promise.all(servers.map((server) => server.stop(true)));
  }
});

test("开启显示缓存时自动退群仍核验实时名单，成功退出后清空显示名", async () => {
  await withHost(undefined, async (connectGateway) => {
    const gateway = await connectGateway(99);
    gateway.receipt(await gateway.take("get_group_list", {}), [{ group_id: groupId }]);
    gateway.receipt(await gateway.take("get_group_member_list", { group_id: groupId }), [
      { group_id: groupId, user_id: 99, role: "owner", nickname: "旧机器人昵称" },
      { group_id: groupId, user_id: 42, nickname: "旧成员昵称" },
    ]);
    gateway.send({
      post_type: "notice", notice_type: "group_increase", group_id: groupId, user_id: 99, time: 1_700_000_000,
    });
    const group = { group_id: groupId, member_count: 1 };
    const bot = { group_id: groupId, user_id: 99, role: "member" };
    gateway.receipt(await gateway.take("get_group_info", { group_id: groupId, no_cache: true }), group);
    gateway.receipt(await gateway.take("get_group_member_list", { group_id: groupId }), [bot]);
    gateway.receipt(await gateway.take("get_group_member_info", { group_id: groupId, user_id: 99, no_cache: true }), bot);
    gateway.receipt(await gateway.take("get_group_info", { group_id: groupId, no_cache: true }), group);
    gateway.receipt(await gateway.take("set_group_leave", { group_id: groupId, is_dismiss: false }));
    await depart(gateway, groupId, 42, null, null);
  }, 1);
}, 10_000);
