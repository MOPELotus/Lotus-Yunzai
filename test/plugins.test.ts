import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("宿主导入正常模块，并在执行入口前拒载旧包、鸣潮插件和重复插件", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-plugins-"));
  const installed = join(root, "plugins");

  async function install(directory: string, name: string, options: object, allowed = false) {
    const path = join(installed, directory);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({
      name,
      lotusYunzai: { entry: "./index.ts" },
      ...options,
    }));
    await writeFile(join(path, "index.ts"), allowed
      ? 'export default { commands: { "#问候": (name: string) => "你好，" + name } };'
      : 'console.log("拒载入口已执行");');
    return path;
  }

  try {
    await cp(new URL("../lib", import.meta.url), join(root, "lib"), { recursive: true });
    await cp(new URL("../app.ts", import.meta.url), join(root, "app.ts"));
    await install("a-hello", "hello", { repository: "https://github.com/example/hello.git" }, true);
    await install("b-duplicate", "hello-fork", { repository: "https://gitee.com/example/hello" });
    const renamed = await install("c-renamed", "locally-renamed", {});
    const git = Bun.which("git")!;
    for (const args of [
      ["init", "--quiet"],
      ["remote", "add", "origin", "git@gitee.com:mirror/miao-plugin.git"],
    ]) {
      expect(await Bun.spawn([git, ...args], { cwd: renamed }).exited).toBe(0);
    }
    await install("d-mixed", "mixed-games", {
      lotusYunzai: { entry: "./index.ts", games: ["genshin", "Wuthering-Waves"] },
    });
    await install("e-legacy", "@example/yenai-plugin", {});
    await install("f-escape", "escaped-entry", { lotusYunzai: { entry: "../a-hello/index.ts" } });

    await install("g-host", "host", {});

    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root,
      env: { PATH: process.env.PATH },
      stdin: new Blob(["#问候 Lotus\n#状态\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited,
    ]);
    expect(exit).toBe(0);
    expect(stdout).toContain("你好，Lotus");
    expect(stdout).toContain("Lotus-Yunzai 正在运行");
    expect(stdout).not.toContain("拒载入口已执行");
    expect(stderr).toContain("拒绝加载 b-duplicate：与 a-hello 重复");
    expect(stderr).toContain("拒绝加载 c-renamed");
    expect(stderr).toContain("拒绝加载 d-mixed（mixed-games）：包含鸣潮功能");
    expect(stderr).toContain("拒绝加载 e-legacy");
    expect(stderr).toContain("拒绝加载 f-escape");
    expect(stderr).toContain("拒绝加载 g-host：模块 host 已注册");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("V3 的 index.js、apps 和单文件经过同一 OneBot 派发，保留规则优先级和权限", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-v3-"));
  let host: ReturnType<typeof Bun.spawn> | undefined;
  let socket: WebSocket | undefined;
  try {
    await cp(new URL("../lib", import.meta.url), join(root, "lib"), { recursive: true });
    await cp(new URL("../app.ts", import.meta.url), join(root, "app.ts"));
    const plugins = join(root, "plugins");
    await mkdir(join(plugins, "legacy"), { recursive: true });
    await mkdir(join(plugins, "example"), { recursive: true });
    await mkdir(join(plugins, "folder-apps", "apps"), { recursive: true });
    await mkdir(join(plugins, "miao-plugin"), { recursive: true });

    await writeFile(join(plugins, "legacy", "index.js"), `
      import Plugin from "../../lib/plugins/plugin.js";
      export const apps = {
        group: class extends Plugin {
          constructor() {
            super({ event: "message.group", priority: 10, rule: [
              { reg: /^#优先$/, fnc: "skip" },
              { reg: "^#管理$", fnc: "admin", permission: "admin" },
              { reg: "^#媒体$", fnc: "media" },
              { reg: "^#引用$", fnc: "quote" },
              { reg: "^#非法段$", fnc: "invalidSegment" },
              { reg: "^#检查来信$", fnc: "incoming" },
              { reg: "^$", fnc: "imageOnly" },
            ] });
          }
          skip() { return false; }
          admin(e) { return this.reply("管理群 " + e.group_id, true); }
          media(e) {
            const image = Buffer.from([0, 1, 2, 3]).subarray(1, 3);
            return e.reply([
              segment.at(e.user_id),
              " [CQ:at,qq=all]",
              segment.image(image),
              { type: "face", data: { id: 14 } },
              segment.record("https://example.invalid/a.ogg"),
              segment.video("/tmp/folder with space/clip.mp4"),
            ], true);
          }
          quote() { return this.reply([segment.reply(456), segment.text("已引用")], true); }
          invalidSegment() {
            const sent = this.reply(["不应发送", { type: "image", data: {} }]);
            return this.reply(sent ? "异常发送" : "已拒绝无效消息");
          }
          incoming(e) {
            return this.reply(JSON.stringify({
              msg: e.msg, raw: e.raw_message, atBot: e.atBot, at: e.at,
              replyId: e.reply_id, images: e.img,
              types: e.message.map(({ type }) => type),
              text: e.message.find(({ type }) => type === "text").text,
            }));
          }
          imageOnly(e) {
            return e.img?.length ? this.reply("收到图片") : false;
          }
        }
      };
    `);
    await writeFile(join(plugins, "example", "legacy.js"), `
      export class Legacy extends plugin {
        constructor() {
          super({ priority: 20, rule: [
            { reg: /^#优先$/g, fnc: "replyLower" },
            { reg: "^#管理$", fnc: "replyLower", permission: "master" },
          ] });
        }
        replyLower(e) {
          return e.reply("收到 " + e.msg + " " + e.user_id);
        }
      }
    `);
    await writeFile(join(plugins, "folder-apps", "apps", "private.js"), `
      export default class extends plugin {
        constructor() {
          super({ event: "message.private.friend", rule: [{ reg: "^#私聊$", fnc: "say" }] });
        }
        say() { return this.reply("私聊可用"); }
      }
    `);
    await writeFile(join(plugins, "miao-plugin", "index.js"), `
      throw new Error("被拒载的旧入口已执行");
    `);

    const backend = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root,
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_TOKEN: "test-token", LOTUS_ONEBOT_PORT: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    host = backend;
    const reader = backend.stdout.getReader();
    const decoder = new TextDecoder();
    let startup = "";
    let endpoint: string | undefined;
    while (!endpoint) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("OneBot 未启动");
      startup += decoder.decode(chunk.value, { stream: true });
      endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(startup)?.[0];
    }
    reader.releaseLock();

    // Bun accepts HTTP headers in the client constructor.
    const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const client = new BunWebSocket(endpoint, {
      headers: { Authorization: "Bearer test-token", "X-Client-Role": "Universal" },
    });
    socket = client;
    await new Promise<void>((ok, fail) => {
      client.addEventListener("open", () => ok(), { once: true });
      client.addEventListener("error", fail, { once: true });
    });

    const event = {
      post_type: "message", message_type: "group", sub_type: "normal",
      self_id: 99, user_id: 42, group_id: 77, message_id: 123,
    };
    async function send(message: string | object[], fields: Record<string, unknown> = {}) {
      const reply = new Promise<Record<string, unknown>>((ok) => {
        client.addEventListener("message", ({ data }) => ok(JSON.parse(data).params), { once: true });
      });
      client.send(JSON.stringify({ ...event, message, ...fields }));
      return reply;
    }

    expect(await send("#优先")).toMatchObject({ group_id: 77, message: "收到 #优先 42" });
    expect(await send("#优先")).toMatchObject({ group_id: 77, message: "收到 #优先 42" });
    expect(await send("#管理", { sender: { role: "member" } })).toMatchObject({
      group_id: 77, message: "暂无权限执行此指令。",
    });
    expect(await send("#管理", { sender: { role: "admin" } })).toMatchObject({
      group_id: 77,
      message: [
        { type: "reply", data: { id: "123" } },
        { type: "text", data: { text: "管理群 77" } },
      ],
    });
    expect(await send("#媒体")).toMatchObject({
      group_id: 77,
      message: [
        { type: "reply", data: { id: "123" } },
        { type: "at", data: { qq: "42" } },
        { type: "text", data: { text: " [CQ:at,qq=all]" } },
        { type: "image", data: { file: "base64://AQI=" } },
        { type: "face", data: { id: "14" } },
        { type: "record", data: { file: "https://example.invalid/a.ogg" } },
        { type: "video", data: { file: "file:///tmp/folder%20with%20space/clip.mp4" } },
      ],
    });
    expect(await send("#引用")).toMatchObject({
      group_id: 77,
      message: [
        { type: "reply", data: { id: "456" } },
        { type: "text", data: { text: "已引用" } },
      ],
    });
    expect(await send("#非法段")).toMatchObject({ group_id: 77, message: "已拒绝无效消息" });
    client.send(JSON.stringify({ ...event, message: [{ type: "text", data: {} }] }));
    const received = await send([
      { type: "reply", data: { id: "456" } },
      { type: "at", data: { qq: "99" } },
      { type: "text", data: { text: " #检查" } },
      { type: "text", data: { text: "来信 " } },
      { type: "image", data: { url: "https://example.invalid/input.jpg" } },
      { type: "at", data: { qq: 42 } },
    ], { raw_message: "协议端原始消息" });
    expect(JSON.parse(String(received.message))).toEqual({
      msg: "#检查来信", raw: "协议端原始消息",
      atBot: true, at: 42, replyId: "456", images: ["https://example.invalid/input.jpg"],
      types: ["reply", "at", "text", "text", "image", "at"], text: " #检查",
    });
    expect(await send([{ type: "image", data: { url: "https://example.invalid/input.jpg" } }]))
      .toMatchObject({ group_id: 77, message: "收到图片" });
    expect(await send("#私聊", { message_type: "private", sub_type: "friend" })).toMatchObject({
      user_id: 42, message: "私聊可用",
    });
    expect(await send("#状态", { message_type: "private", sub_type: "friend" })).toMatchObject({
      user_id: 42, message: expect.stringContaining("Lotus-Yunzai 正在运行"),
    });

    client.close();
    backend.kill();
    await backend.exited;
    const stderr = await new Response(backend.stderr).text();
    expect(stderr).toContain("拒绝加载 miao-plugin");
    expect(stderr).not.toContain("被拒载的旧入口已执行");
  } finally {
    socket?.close();
    host?.kill();
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
});
