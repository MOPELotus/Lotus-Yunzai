import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("原生消息回退可退让，沿用群权限并查询当前机器人的主人", () => withHost(async (root) => {
  const config = join(root, "config/config");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "other.yaml"), 'master: ["99:51", "100:52"]\n');
  await writeFile(join(config, "group.yaml"), 'default: { groupCD: 0, singleCD: 0, onlyReplyAt: 0 }\n"81": { disable: [fixture-fallback] }\n');
  const plugin = join(root, "plugins/fixture-fallback");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, "package.json"), JSON.stringify({
    name: "fixture-fallback", lotusYunzai: { entry: "./index.ts" },
  }));
  await writeFile(join(plugin, "index.ts"), `
    export default {
      commands: { "#现代优先": () => "现代处理" },
      fallback(message, { isMaster, isBotMaster, reply_id, message: segments }) {
        if (message.startsWith("#")) return "回退误抢显式指令";
        if (message === "引用触发") return { type: "quoted", message: "带引用的结果" };
        if (message !== "旧触发") return;
        return [isMaster, isBotMaster(51), isBotMaster(52), reply_id, segments.map(item => item.type).join(",")].join("/");
      },
    };
  `);
  await writeFile(join(root, "plugins/fixture-fallback-legacy.js"), `
    export default class extends plugin {
      constructor() { super({ rule: [{ reg: "^#旧版优先$", fnc: "run" }] }); }
      run() { return this.reply("旧版处理"); }
    }
  `);
}, async (connect) => {
  const first = await connect(99);
  const second = await connect(100);
  const message: Inbound = [
    { type: "reply", data: { id: "123" } },
    { type: "text", data: { text: "旧触发" } },
    { type: "at", data: { qq: "51" } },
    { type: "image", data: { file: "fixture.png" } },
  ];
  first.send("#现代优先", 77);
  await first.reply("现代处理", 77);
  first.send("#旧版优先", 77);
  await first.reply("旧版处理", 77);
  first.send(message, 77);
  await first.reply("false/true/false/123/reply,text,at,image", 77);
  second.send(message, 77);
  await second.reply("false/false/true/123/reply,text,at,image", 77);
  first.send("引用触发", 77);
  await first.reply([
    { type: "reply", data: { id: "4" } },
    { type: "text", data: { text: "带引用的结果" } },
  ], 77);
  first.send("无匹配", 77);
  first.send(message, 81);
  first.send("#状态", 81);
  await first.reply(expect.stringContaining("Lotus-Yunzai 正在运行"), 81);
}), 12_000);

test("旧表情触发从宿主提交生成请求，沿用旧群禁用名和引用回复", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
  const requests: FormData[] = [];
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/memes/sample/") {
      return new Response(null, { status: 404 });
    }
    requests.push(await request.formData());
    return new Response(Uint8Array.fromBase64(png), { headers: { "content-type": "image/png" } });
  } });
  try {
    await withHost(async (root) => {
      const plugin = join(root, "plugins/meme");
      await mkdir(plugin);
      for (const file of ["package.json", "lotus.ts", "catalog-policy.ts", "generation.ts", "generate-reply.ts"]) {
        await cp(new URL(`../plugins/meme/${file}`, import.meta.url), join(plugin, file));
      }
      const config = join(root, "config/config");
      const memeConfig = join(root, "data/meme/config");
      await mkdir(config, { recursive: true });
      await mkdir(memeConfig, { recursive: true });
      await writeFile(join(config, "group.yaml"), 'default: { groupCD: 0, singleCD: 0, onlyReplyAt: 0 }\n"81": { disable: ["清语表情:表情包生成"] }\n');
      await writeFile(join(memeConfig, "server.yaml"), `url: "${service.url.href}"\n`);
      await writeFile(join(memeConfig, "meme.yaml"), "reply: true\n");
      const db = new Database(join(memeConfig, "../data.db"));
      try {
        db.run("CREATE TABLE meme (key TEXT PRIMARY KEY, keyWords TEXT, min_images INTEGER, max_images INTEGER, min_texts INTEGER, max_texts INTEGER, params TEXT)");
        db.run("INSERT INTO meme VALUES ('sample', ?, 1, 1, 1, 1, ?)", [JSON.stringify(["表情夹具"]),
          JSON.stringify({ min_images: 1, max_images: 1, min_texts: 1, max_texts: 1 })]);
      } finally {
        db.close();
      }
    }, async (connect) => {
      const bot = await connect(99);
      const trigger: Inbound = [
        { type: "text", data: { text: "表情夹具 晚安" } },
        { type: "image", data: { file: `base64://${png}` } },
      ];
      bot.send(trigger, 77);
      await bot.reply([
        { type: "reply", data: { id: "1" } },
        { type: "image", data: { file: `base64://${png}` } },
      ], 77);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.getAll("texts")).toEqual(["晚安"]);
      expect(await (requests[0]?.get("images") as Blob).bytes()).toEqual(Uint8Array.fromBase64(png));
      bot.send(trigger, 81);
      bot.send("#状态", 81);
      await bot.reply(expect.stringContaining("Lotus-Yunzai 正在运行"), 81);
      expect(requests).toHaveLength(1);
    });
  } finally {
    await service.stop(true);
  }
}, 12_000);
