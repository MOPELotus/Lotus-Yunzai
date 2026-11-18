import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

type Inbound = string | { type: string; data: Record<string, string> }[];
interface Action {
  action: string;
  echo?: string;
  params: Record<string, unknown>;
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 2_500);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function readEndpoint(host: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const reader = host.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) throw new Error("测试宿主没有启动 OneBot 入口。");
      output += decoder.decode(part.value, { stream: true });
      const endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      if (endpoint) return endpoint;
    }
  } finally {
    reader.releaseLock();
  }
}

function gateway(url: string, botId: number) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(url, {
    headers: { Authorization: "Bearer group-routing-fixture", "X-Client-Role": "Universal", "X-Self-ID": String(botId) },
  });
  const connected = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
  const frames: Action[] = [];
  let available = Promise.withResolvers<void>();
  socket.addEventListener("message", ({ data }) => {
    frames.push(JSON.parse(data));
    available.resolve();
  });
  let nextId = 0;
  async function action(): Promise<Action> {
    if (!frames.length) await deadline(available.promise, `机器人 ${botId} 未收到预期的操作。`);
    const frame = frames.shift()!;
    if (!frames.length) available = Promise.withResolvers<void>();
    return frame;
  }
  return {
    connected,
    closed,
    close: () => socket.close(),
    sendFrame: (frame: object) => socket.send(JSON.stringify({ self_id: botId, ...frame })),
    action,
    send(message: Inbound, groupId: number, userId = 42, raw?: string) {
      const messageId = ++nextId;
      socket.send(JSON.stringify({
        self_id: botId, user_id: userId, group_id: groupId, post_type: "message", message_type: "group",
        sub_type: "normal", message_id: messageId, raw_message: raw ?? `fixture-${messageId}`, message,
      }));
    },
    async reply(expected: unknown, groupId: number) {
      expect(await action()).toMatchObject({ action: "send_msg", params: { message: expected, group_id: groupId } });
    },
    assertNoPendingFrames() { expect(frames).toEqual([]); },
  };
}

type Gateway = ReturnType<typeof gateway>;

async function withHost(
  prepare: (root: string) => Promise<void>,
  run: (connect: (botId: number) => Promise<Gateway>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-group-routing-"));
  const clients: Gateway[] = [];
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await copyHost(root);
    await prepare(root);
    disableMemberPrewarm(root);
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: "group-routing-fixture" },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const endpoint = await deadline(readEndpoint(host), "测试宿主启动超时。");
      await run(async (botId) => {
        const client = gateway(endpoint, botId);
        clients.push(client);
        await deadline(client.connected, `无法连接机器人 ${botId} 的模拟网关。`);
        return client;
      });
      host.kill();
      await deadline(host.exited, "测试宿主退出超时。");
      for (const client of clients) {
        await deadline(client.closed, "测试网关断开超时。");
        client.assertNoPendingFrames();
      }
      expect(await stderr).not.toContain("处理 OneBot 事件失败");
    } finally {
      for (const client of clients) client.close();
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function installFixtures(root: string) {
  await mkdir(join(root, "config/config"), { recursive: true });
  await writeFile(join(root, "config/config/other.yaml"), `
master: ["99:51", "100:51"]
blackUser: [90]
whiteUser: [42, 51, 90]
blackGroup: [89]
whiteGroup: [77, 80, 81, 82, 83, 89]
`);
  await writeFile(join(root, "config/config/bot.yaml"), '"/→#": true\n');
  await writeFile(join(root, "config/config/group.yaml"), `
default: { groupCD: 0, singleCD: 0, onlyReplyAt: 1, botAlias: 默认 }
"99:default": { botAlias: 账号 }
"77": { onlyReplyAt: 2, botAlias: 群前缀 }
"99:77": { onlyReplyAt: 1, botAlias: [专用, 小名] }
"81": { onlyReplyAt: 0, enable: [system, fixture-modern, legacy-routes.js] }
"82": { onlyReplyAt: 0, enable: ["@lotus-yunzai/system", fixture-modern, 旧会话], disable: [fixture-modern, 旧会话] }
"83": { onlyReplyAt: 0, disable: ["@lotus-yunzai/system", legacy-routes.js] }
`);
  for (const [name, command] of [["fixture-modern", "#现代"], ["fixture-other", "#现代旁路"]] as const) {
    const directory = join(root, "plugins", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, lotusYunzai: { entry: "./index.ts" } }));
    await writeFile(join(directory, "index.ts"), `export default { commands: {
      "${command}": (args) => ${JSON.stringify(command)} + " " + args,
      ${name === "fixture-modern" ? '"#星铁探针": () => "现代星铁命中",' : ""}
    } };`);
  }
  await writeFile(join(root, "plugins", "legacy-routes.js"), `
    export default class LegacyRoutes extends plugin {
      constructor() {
        super({ name: "旧会话", event: "message.group", rule: [
          { reg: /^#旧版$/, fnc: "entry" },
          { reg: /^#开始(?: \\d+)?$/, fnc: "start" },
          { reg: /^#绝区零探针$/, fnc: "checkGame" },
        ] });
      }
      entry() { return this.reply("旧版已执行"); }
      checkGame(e) { return this.reply("旧版命中 " + e.game); }
      start(e) {
        const destination = e.msg.split(" ")[1];
        if (destination) this.e = { ...e, group_id: Number(destination) };
        this.setContext("resume", false, 15, "");
        this.e = e;
        return this.reply("会话已开始");
      }
      resume() {
        this.finish("resume");
        return this.reply("收到接续 " + this.e.msg);
      }
    }
  `);
}

test("TRSS 群策略合并四层配置并约束同一宿主的现代指令和旧插件会话", () => withHost(installFixtures, async (connect) => {
  const a = await connect(99);
  const b = await connect(100);
  const alive = expect.stringContaining("Lotus-Yunzai 正在运行");

  a.send("默认#状态", 80);
  a.send("账号#状态", 80);
  await a.reply(alive, 80);
  b.send("账号#状态", 80);
  b.send("默认#状态", 80);
  await b.reply(alive, 80);

  b.send("#状态", 77);
  b.send("默认#状态", 77);
  b.send("群前缀#状态", 77);
  await b.reply(alive, 77);
  b.send("#状态", 77, 51);
  await b.reply(alive, 77);
  a.send("#状态", 77, 51);
  a.send("群前缀#状态", 77);
  a.send("账号#状态", 77);
  a.send("专用#状态", 77);
  await a.reply(alive, 77);
  a.send("小名#状态", 77);
  await a.reply(alive, 77);
  a.send("专用 ＃状态", 77);
  await a.reply(alive, 77);
  a.send("专用 /状态", 77);
  await a.reply(alive, 77);
  a.send("专用 崩铁探针", 77);
  await a.reply("现代星铁命中", 77);
  a.send("专用 ％探针", 77);
  await a.reply("旧版命中 zzz", 77);
  a.send([{ type: "at", data: { qq: "100" } }, { type: "text", data: { text: "#状态" } }], 77);
  a.send([{ type: "at", data: { qq: "99" } }, { type: "text", data: { text: "#状态" } }], 77);
  await a.reply(alive, 77);

  a.send("账号#状态", 80, 90);
  a.send("账号#状态", 80, 91);
  a.send("账号#状态", 89);
  a.send("账号#状态", 88);
  a.send("账号#现代 黑白名单屏障", 80);
  await a.reply("#现代 黑白名单屏障", 80);

  a.send("#现代旁路 未在白名单", 81);
  a.send("#旧版", 81);
  await a.reply("旧版已执行", 81);
  a.send("#现代 已允许", 81);
  await a.reply("#现代 已允许", 81);
  a.send("#状态", 81);
  await a.reply(alive, 81);
  a.send("#现代 双重名单", 82);
  a.send("#旧版", 82);
  a.send("#状态", 82);
  await a.reply(alive, 82);
  a.send("#状态", 83);
  a.send("#旧版", 83);
  a.send("#现代 按标签禁用", 83);
  await a.reply("#现代 按标签禁用", 83);

  a.send("专用#开始", 77);
  await a.reply("会话已开始", 77);
  b.send("不是机器人 99 的会话", 77);
  b.send("群前缀#现代 身份隔离", 77);
  await b.reply("#现代 身份隔离", 77);
  a.send("星穹铁道探针", 77);
  await a.reply("收到接续 星穹铁道探针", 77);

  for (const groupId of [82, 83]) {
    a.send(`账号#开始 ${groupId}`, 80);
    await a.reply("会话已开始", 80);
    a.send("不得执行的续答", groupId);
    if (groupId === 82) {
      a.send("#状态", groupId);
      await a.reply(alive, groupId);
    } else {
      a.send("#现代 旧会话已禁用", groupId);
      await a.reply("#现代 旧会话已禁用", groupId);
    }
  }
}), 12_000);

test("没有 group.yaml 时普通群聊保持现有指令派发", () => withHost(async () => {}, async (connect) => {
  const a = await connect(99);
  const alive = expect.stringContaining("Lotus-Yunzai 正在运行");
  a.send("#状态", 77, 42, "#状态");
  a.send("#状态", 77, 42, "#状态");
  await a.reply(alive, 77);
  await a.reply(alive, 77);
}), 7_000);

test("OneBot 群禁言按机器人生效，全员禁言保留管理员入口", () => withHost(async () => {}, async (connect) => {
  const a = await connect(99);
  const b = await connect(100);
  const alive = expect.stringContaining("Lotus-Yunzai 正在运行");
  const ban = { post_type: "notice", notice_type: "group_ban", group_id: 77 };

  a.sendFrame({ ...ban, sub_type: "ban", user_id: 99, duration: 60 });
  a.send("#状态", 77);
  a.send("#状态", 78);
  await a.reply(alive, 78);
  b.send("#状态", 77);
  await b.reply(alive, 77);
  a.sendFrame({ ...ban, sub_type: "lift_ban", user_id: 99, duration: 0 });
  a.send("#状态", 77);
  await a.reply(alive, 77);

  a.sendFrame({ ...ban, sub_type: "ban", user_id: 0, duration: 0 });
  a.send("#状态", 77);
  const lookup = await a.action();
  expect(lookup).toMatchObject({ action: "get_group_member_info", params: {
    group_id: 77, user_id: 99, no_cache: true,
  } });
  a.sendFrame({ echo: lookup.echo, status: "ok", retcode: 0, data: { role: "member" } });
  a.send("#状态", 78);
  await a.reply(alive, 78);
  a.sendFrame({ post_type: "notice", notice_type: "group_admin", group_id: 77, user_id: 99, sub_type: "set" });
  a.send("#状态", 77);
  const updated = await a.action();
  expect(updated.action).toBe("get_group_member_info");
  a.sendFrame({ echo: updated.echo, status: "ok", retcode: 0, data: { role: "admin" } });
  await a.reply(alive, 77);
  a.sendFrame({ ...ban, sub_type: "lift_ban", user_id: 0, duration: 0 });
  a.send("#状态", 77);
  await a.reply(alive, 77);
}), 9_000);
