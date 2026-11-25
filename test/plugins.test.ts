function plainOutput(text: string) { return text.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\[[A-Z]+\] (?:\[Lotus-Yunzai\] )?/gm, ""); }
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessageEvent as BotMessageEvent } from "../lib/messages.ts";
import { PluginContexts } from "../lib/plugins/contexts.ts";
import { copyHost } from "./host-fixture.ts";

test("V3 等待输入和群上下文按接入协议隔离", async () => {
  const contexts = new PluginContexts();
  const onebot: BotMessageEvent = {
    msg: "#接续", raw_message: "#接续", message: "#接续", post_type: "message",
    message_type: "group", self_id: 99, group_id: 77, user_id: 42,
    isGroup: true, isPrivate: false, isMaster: false, reply: () => true,
  };
  const milky = { ...onebot, adapter: "milky" } as const;
  const otherOnebotMember = { ...onebot, user_id: 43 };

  try {
    const onebotInput = contexts.wait(onebot, false, 0);
    const milkyInput = contexts.wait(milky, false, 0);
    expect(contexts.resolve(otherOnebotMember)).toBe(false);
    expect(contexts.resolve(milky)).toBe(true);
    expect(await milkyInput).toBe(milky);
    expect(contexts.resolve(onebot)).toBe(true);
    expect(await onebotInput).toBe(onebot);

    contexts.set(onebot, "finishGroupStep", true, 0, "");
    expect(contexts.get(milky, true)).toEqual({});
    contexts.finish(milky, "finishGroupStep", true);
    expect(contexts.get(otherOnebotMember, true)).toEqual({ finishGroupStep: onebot });
    const groupInput = contexts.wait(onebot, true, 0);
    expect(contexts.resolve(milky)).toBe(false);
    expect(contexts.resolve(otherOnebotMember)).toBe(true);
    expect(await groupInput).toBe(otherOnebotMember);
  } finally {
    contexts.close();
  }
});

test("宿主导入正常模块，并在执行入口前拒载库洛游戏插件和重复插件", async () => {
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
    await copyHost(root);
    const hello = await install("a-hello", "hello", { repository: "https://github.com/example/hello.git" }, true);
    await writeFile(join(hello, "index.ts"), `
      export function createModule({ groups, signal }) {
        signal.addEventListener("abort", () => console.log("模块收到退出信号"), { once: true });
        return {
          commands: { "#问候": (name) => groups.onlineBots().length === 0 ? "你好，" + name : "意外在线" },
          async dispose() {
            await Bun.sleep(10);
            console.log(signal.aborted ? "模块完成清理" : "模块清理顺序错误");
          },
        };
      }
    `);
    const invalid = await install("h-failed", "broken-cleanup", {}, true);
    await writeFile(join(invalid, "index.ts"), `
      export function createModule() {
        return {
          commands: { "#问候": () => "不应覆盖指令" },
          dispose() { console.log("失败模块完成清理"); },
        };
      }
    `);
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
    await install("d-pgr", "renamed-pgr", { repository: "https://github.com/Loping151/PGRUID.git" });
    await install("d-kuro", "renamed-mixed", { repository: "https://github.com/TomyJan/Yunzai-Kuro-Plugin.git" });
    await install("d-twintail", "twintail", {
      lotusYunzai: { entry: "./index.ts", games: ["Twin Tails Battleground", "Punishing: Gray Raven"] },
    });
    await install("d-replaced", "xhh-tl", {
      lotusYunzai: { entry: "./index.ts", games: ["戦場ツインテール", "PGR"] },
    });
    const unrelated = await install("d-kuro-sandbox", "kuro-sandbox", {}, true);
    await writeFile(join(unrelated, "index.ts"), 'export default { commands: { "#正常插件": () => "普通插件正常加载" } };');
    await install("e-legacy", "@example/yenai-plugin", {});
    await install("f-escape", "escaped-entry", { lotusYunzai: { entry: "../a-hello/index.ts" } });

    await install("g-system", "@lotus-yunzai/system", {});

    await writeFile(join(installed, "await.js"), `
      export default class extends plugin {
        constructor() {
          super({ rule: [{ reg: "^#等待$", fnc: "wait" }] });
        }
        async wait() {
          this.reply("请输入内容");
          const input = await this.awaitContext();
          return this.reply(input ? "收到 " + input.msg : "会话已结束");
        }
      }
    `);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/server.yaml"), "onebot_enable: false\n");
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root,
      env: { PATH: process.env.PATH },
      stdin: new Blob(["#问候 Lotus\n#正常插件\n#等待\nLotus\n#状态\n#帮助\n#等待\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited,
    ]);
    expect(exit).toBe(0);
    expect(plainOutput(stdout)).toContain("你好，Lotus");
    expect(plainOutput(stdout)).toContain("普通插件正常加载");
    expect(plainOutput(stdout)).toContain("请输入内容\n收到 Lotus\n");
    expect(plainOutput(stdout)).toContain("请输入内容\n模块收到退出信号\n会话已结束\n模块完成清理\n");
    expect(plainOutput(stdout)).toContain("失败模块完成清理");
    expect(plainOutput(stdout)).toContain("Lotus-Yunzai 正在运行");
    expect(plainOutput(stdout)).toContain("https://www.lotusshared.cn/yunzai/");
    expect(plainOutput(stdout)).not.toContain("拒载入口已执行");
    expect(stderr).toContain("拒绝加载 b-duplicate：与 a-hello 重复");
    expect(stderr).toContain("拒绝加载 c-renamed");
    expect(stderr).toContain("拒绝加载 d-mixed（mixed-games）：包含鸣潮功能");
    expect(stderr).toContain("拒绝加载 d-pgr（renamed-pgr）：包含战双帕弥什功能");
    expect(stderr).toContain("拒绝加载 d-kuro（renamed-mixed）：包含鸣潮、战双帕弥什功能");
    expect(stderr).toContain("拒绝加载 d-twintail（twintail）：包含战双帕弥什、战场双马尾功能");
    expect(stderr).toContain("拒绝加载 d-replaced（xhh-tl）：旧插件功能已归并");
    expect(stderr).toContain("拒绝加载 e-legacy");
    expect(stderr).toContain("拒绝加载 f-escape");
    expect(stderr).toContain("拒绝加载 g-system：@lotus-yunzai/system 的内置目录为 plugins/system");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("V3 的 index.js、apps 和单文件经过同一 OneBot 派发，保留规则优先级和权限", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-v3-"));
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => Response.json({
    accept: request.headers.get("Accept"),
  }) });
  let host: ReturnType<typeof Bun.spawn> | undefined;
  const sockets: WebSocket[] = [];
  try {
    await copyHost(root);
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
              { reg: "^#分步$", fnc: "startStep" },
              { reg: "^#跨群$", fnc: "startGroupStep" },
              { reg: "^#等输入$", fnc: "waitInput" },
              { reg: "^#等超时$", fnc: "waitTimeout" },
              { reg: "^$", fnc: "imageOnly" },
            ] });
          }
          init() {
            const timer = setInterval(() => {}, 60_000);
            this.addCleanup(() => {
              clearInterval(timer);
              console.warn("OneBot 插件已清理");
            });
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
          startStep() {
            this.setContext("finishStep");
            return this.reply("下一条");
          }
          finishStep(origin) {
            this.finish("finishStep");
            return this.reply(origin.msg + " → " + this.e.msg);
          }
          startGroupStep() {
            this.setContext("finishGroupStep", true);
            return this.reply("等群内回复");
          }
          finishGroupStep(origin) {
            this.finish("finishGroupStep", true);
            return this.reply(origin.user_id + " → " + this.e.user_id);
          }
          async waitInput() {
            this.reply("等待同群输入");
            const input = await this.awaitContext();
            return this.reply(input ? this.e.msg + " → " + input.msg : "等待结束");
          }
          async waitTimeout() {
            const input = await this.awaitContext(false, 0.01);
            return this.reply(input === false ? "等待超时" : "意外接续");
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
      import fetch, { Headers } from "node-fetch";
      logger.info("V3 夹具载入");
      export class Legacy extends plugin {
        constructor() {
          super({ priority: 20, rule: [
            { reg: /^#优先$/g, fnc: "replyLower" },
            { reg: "^#管理$", fnc: "replyLower", permission: "master" },
            { reg: "^#旧 HTTP 查询$", fnc: "lookup" },
            { reg: "^#期望计算帮助$", fnc: "replyLower" },
          ] });
        }
        replyLower(e) {
          return e.reply("收到 " + e.msg + " " + e.user_id);
        }
        async lookup(e) {
          const headers = new Headers({ Accept: "application/json" });
          const response = await fetch(${JSON.stringify(upstream.url.href)}, { headers });
          logger.mark("V3 夹具查询完成");
          return e.reply((await response.json()).accept);
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
    await writeFile(join(plugins, "group-notice.js"), `
      export const apps = {
        join: class extends plugin {
          constructor() { super({ event: "notice.group.increase", priority: 1 }); }
          async accept(e) {
            if (e.group_id !== 77) return false;
            const group = await e.getGroupName();
            const sent = await this.reply([segment.image("https://example.invalid/join.jpg")]);
            if (!sent) this.reply(JSON.stringify({
              type: e.notice_type, change: e.sub_type, action: e.increase_type,
              bot: e.self_id, user: e.user_id, inviter: e.inviter_id, member: e.member, group,
            }));
            return "return";
          }
        },
        leave: class extends plugin {
          constructor() {
            super({ event: "notice.group.decrease", rule: [{ fnc: "onLeave" }] });
          }
          onLeave(e) { return e.group_id === 77 && this.reply(e.decrease_type + " " + e.operator_id); }
        },
        catchall: class extends plugin {
          constructor() { super({ event: "notice.group.increase", rule: [{ fnc: "unexpected" }] }); }
          unexpected(e) { return e.group_id === 77 && this.reply("意外匹配进群规则"); }
        },
      };
    `);
    await mkdir(join(plugins, "context"), { recursive: true });
    await writeFile(join(plugins, "context", "package.json"), JSON.stringify({
      name: "fixture-context", lotusYunzai: { entry: "./index.ts" },
    }));
    await writeFile(join(plugins, "context", "index.ts"), `
      export default { commands: {
        "#会话": (args, context) => {
          const { message_type, user_id, group_id, self_id, isMaster, member } = context;
          return [
            { type: "text", text: JSON.stringify({ args, message_type, user_id, group_id, self_id, isMaster, member }) },
            { type: "at", qq: user_id },
          ];
        },
        "#消息段": (args, { message, raw_message }) => JSON.stringify({ args, message, raw_message }),
        "#群审核能力": async (args, context) => {
          if (!context.reviewGroupRequest) return "无审核能力";
          const approved = await context.reviewGroupRequest("test-event", "invite", false, args);
          return approved ? "审核已确认" : "审核被拒绝";
        },
      } };
      export const apps = {
        recall: class extends plugin {
          constructor() {
            super({ event: "message.group", rule: [{ reg: "^#回复撤回$", fnc: "send", permission: "master" }] });
          }
          send() {
            return this.reply("测试撤回", true, { at: true, recallMsg: 0.05 });
          }
        },
        request: class extends plugin {
          constructor() { super({ event: "request.group.invite", priority: 1 }); }
          async accept(e) {
            if (e.group_id !== 90) return false;
            await e.notifyMasters("群 " + e.group_id + " 邀请，发起人 " + e.user_id + "，附言 " + e.comment);
            return "return";
          }
        },
      };
    `);
    await writeFile(join(plugins, "miao-plugin", "index.js"), `
      throw new Error("被拒载的旧入口已执行");
    `);

    await mkdir(join(root, "config"), { recursive: true });
    await mkdir(join(root, "config", "config"), { recursive: true });
    await writeFile(join(root, "config", "config", "other.yaml"), 'master:\n  - "99:51"\n');
    await writeFile(join(root, "config", "config", "server.yaml"),
      "port: 0\nauth:\n  Authorization: Bearer test-token\n  X-Server-Key: integration\n");
    await cp(new URL("../plugins/group", import.meta.url), join(plugins, "group"), {
      recursive: true, filter: (path) => !path.endsWith("/.git"),
    });
    await writeFile(join(root, "config", "group.yaml"), `
strangeThumbUp: false
count: 3
successMsg: "确认 {{thumbUpNum}}"
failsMsg: 协议拒绝
`);
    const profiles = join(root, "profiles");
    await mkdir(profiles);
    await writeFile(join(profiles, "42.yaml"), "account: { cookie: fixture-private, stoken: fixture-secret }");
    await writeFile(join(profiles, "42-2.yaml"), "profile: { id: 2 }");
    await writeFile(join(profiles, "42-3.yaml"), "invalid: [");
    await writeFile(join(profiles, "51.yaml"), "account: { cookie: other-user, stoken: other-secret }");
    const backend = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root,
      env: { LOTUS_HTTP_PORT: "0", PATH: process.env.PATH, LOTUS_PROFILE_DIR: profiles, LOTUS_PANEL_TOKEN: "group-settings-fixture" },
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

    const http = new URL("/status", endpoint.replace(/^ws/u, "http"));
    const authorizedHeaders = { Authorization: "Bearer test-token", "X-Server-Key": "integration" };
    expect((await fetch(http)).status).toBe(401);
    const status = await fetch(http, { headers: authorizedHeaders });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: "ok", name: "Lotus-Yunzai", bun: Bun.version });
    expect((await fetch(http, { headers: authorizedHeaders, method: "POST" })).status).toBe(405);
    expect((await fetch(http, { headers: authorizedHeaders, method: "HEAD" })).status).toBe(200);
    expect((await fetch(new URL("/panel/api/status", http), { headers: authorizedHeaders })).status).toBe(401);

    // Bun accepts HTTP headers in the client constructor.
    const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    async function connect(botId: number) {
      const gateway = new BunWebSocket(endpoint!, {
        headers: { ...authorizedHeaders, "X-Client-Role": "Universal", "X-Self-ID": String(botId) },
      });
      sockets.push(gateway);
      const prewarmed = Promise.withResolvers<void>();
      gateway.addEventListener("message", (event) => {
        const { action, echo } = JSON.parse(event.data);
        const list = action === "get_group_list" || action === "get_group_member_list";
        if (!list && action !== "get_login_info") return;
        event.stopImmediatePropagation();
        const data = list ? [] : { user_id: botId, nickname: "V3 夹具" };
        gateway.send(JSON.stringify({ echo, status: "ok", retcode: 0, data }));
        if (action === "get_group_list") prewarmed.resolve();
      });
      await new Promise<void>((ok, fail) => {
        gateway.addEventListener("open", () => ok(), { once: true });
        gateway.addEventListener("error", fail, { once: true });
      });
      await prewarmed.promise;
      return gateway;
    }
    const client = await connect(99);

    const event = {
      post_type: "message", message_type: "group", sub_type: "normal",
      self_id: 99, user_id: 42, group_id: 77, message_id: 123,
    };
    async function send(message: string | object[], fields: Record<string, unknown> = {}, gateway = client) {
      const reply = new Promise<Record<string, unknown>>((ok) => {
        gateway.addEventListener("message", ({ data }) => ok(JSON.parse(data).params), { once: true });
      });
      gateway.send(JSON.stringify({ ...event, message, ...fields }));
      return reply;
    }

    expect(await send("#优先")).toMatchObject({ group_id: 77, message: "收到 #优先 42" });
    expect(await send("#期望计算帮助")).toMatchObject({
      group_id: 77, message: expect.stringContaining("#期望分布"),
    });
    const estimate = new Promise<Record<string, unknown>[]>(resolve => {
      const frames: Record<string, unknown>[] = [];
      const receive = ({ data }: MessageEvent) => {
        frames.push(JSON.parse(data).params);
        if (frames.length < 2) return;
        client.removeEventListener("message", receive);
        resolve(frames);
      };
      client.addEventListener("message", receive);
    });
    client.send(JSON.stringify({ ...event, message: "#期望计算星铁 人物 1个" }));
    expect(await estimate).toMatchObject([
      { group_id: 77, message: "正在计算平均抽数…" },
      { group_id: 77, message: [
        { type: "reply", data: { id: "123" } },
        { type: "text", data: { text: expect.stringContaining("期望抽数 89.55 抽") } },
      ] },
    ]);
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
    const cqMessage = "[CQ:reply,id=456][CQ:at,qq=99] #检查[CQ:image,file=old.jpg,url=https://example.invalid/?name=a&#44;b&amp;q=x=y]来信 [CQ:at,qq=42]";
    expect(JSON.parse(String((await send(cqMessage)).message))).toEqual({
      msg: "#检查来信", raw: cqMessage, atBot: true, at: "42", replyId: "456",
      images: ["https://example.invalid/?name=a,b&q=x=y"],
      types: ["reply", "at", "text", "image", "text", "at"], text: " #检查",
    });
    const escapedCQ = "#会话 &#91;CQ:at,qq=99&#93; &amp;#91; [CQ:at,invalid] [CQ:at] &#44;";
    const escaped = await send(escapedCQ);
    expect(escaped.message).toMatchObject([{ type: "text", data: { text: expect.stringContaining(
      '"args":"[CQ:at,qq=99] &#91; [CQ:at,invalid] [CQ:at] &#44;"',
    ) } }, { type: "at", data: { qq: "42" } }]);
    expect(await send([{ type: "image", data: { url: "https://example.invalid/input.jpg" } }]))
      .toMatchObject({ group_id: 77, message: "收到图片" });
    const structured = await send([
      { type: "text", data: { text: "#消息段" } },
      { type: "image", data: { url: "https://example.invalid/input.jpg" } },
    ], { raw_message: "#消息段[CQ:image,file=fixture]" });
    expect(JSON.parse(String(structured.message))).toEqual({
      args: "", raw_message: "#消息段[CQ:image,file=fixture]",
      message: [
        { type: "text", text: "#消息段" },
        { type: "image", url: "https://example.invalid/input.jpg" },
      ],
    });
    expect(await send("#私聊", { message_type: "private", sub_type: "friend" })).toMatchObject({
      user_id: 42, message: "私聊可用",
    });
    expect(await send("#旧 HTTP 查询")).toMatchObject({ group_id: 77, message: "application/json" });
    const context = await send("#会话 999 无关编号", { sender: { role: "admin" } });
    expect(context).toMatchObject({
      group_id: 77,
      message: [
        { type: "text", data: { text: JSON.stringify({
          args: "999 无关编号", message_type: "group", user_id: 42, group_id: 77, self_id: 99,
          isMaster: false, member: { is_admin: true, is_owner: false },
        }) } },
        { type: "at", data: { qq: "42" } },
      ],
    });
    expect(await send("#管理", { message_type: "private", user_id: 51 })).toMatchObject({
      user_id: 51, message: "收到 #管理 51",
    });
    const otherBot = await connect(98);
    expect(await send("#管理", { message_type: "private", user_id: 51, self_id: 98, isMaster: true }, otherBot))
      .toMatchObject({ user_id: 51, message: "暂无权限执行此指令。" });
    otherBot.close();
    expect(await send("#登录列表")).toMatchObject({
      group_id: 77, message: "登录列表\n档案 1 · 已登录\n档案 2 · 未登录\n档案 3 · 无法读取",
    });
    expect(await send("#登录列表 51")).toMatchObject({ group_id: 77, message: "用法：#登录列表" });
    expect(await send("#登录列表", { user_id: 51, message_type: "private", sub_type: "friend" }))
      .toMatchObject({ user_id: 51, message: "登录列表\n档案 1 · 已登录" });
    expect(await send("#分步")).toMatchObject({ group_id: 77, message: "下一条" });
    expect(await send("#状态", { group_id: 78 })).toMatchObject({
      group_id: 78, message: expect.stringContaining("Lotus-Yunzai 正在运行"),
    });
    expect(await send("#状态", { user_id: 43 })).toMatchObject({
      group_id: 77, message: expect.stringContaining("Lotus-Yunzai 正在运行"),
    });
    expect(await send("#状态")).toMatchObject({ group_id: 77, message: "#分步 → #状态" });
    expect(await send("#状态")).toMatchObject({
      group_id: 77, message: expect.stringContaining("Lotus-Yunzai 正在运行"),
    });
    expect(await send("#跨群")).toMatchObject({ group_id: 77, message: "等群内回复" });
    expect(await send("#状态", { user_id: 43 })).toMatchObject({ group_id: 77, message: "42 → 43" });
    expect(await send("#等输入")).toMatchObject({ group_id: 77, message: "等待同群输入" });
    expect(await send("#状态", { user_id: 43 })).toMatchObject({
      group_id: 77, message: expect.stringContaining("Lotus-Yunzai 正在运行"),
    });
    expect(await send("#状态", { group_id: 78 })).toMatchObject({
      group_id: 78, message: expect.stringContaining("Lotus-Yunzai 正在运行"),
    });
    expect(await send("#状态")).toMatchObject({ group_id: 77, message: "#等输入 → #状态" });
    expect(await send("#等超时")).toMatchObject({ group_id: 77, message: "等待超时" });

    function nextFrame(): Promise<Record<string, unknown>> {
      return new Promise((ok) => {
        client.addEventListener("message", ({ data }) => ok(JSON.parse(data)), { once: true });
      });
    }

    const invited = {
      post_type: "request", request_type: "group", sub_type: "invite", self_id: 99,
      group_id: 90, user_id: 62, comment: "测试邀请", flag: "test-event",
    };
    const notified = nextFrame();
    client.send(JSON.stringify({ ...invited, flag: 1 }));
    client.send(JSON.stringify(invited));
    const invitation = await notified;
    expect(invitation).toMatchObject({ action: "send_msg", params: {
      message_type: "private", user_id: 51, message: "群 90 邀请，发起人 62，附言 测试邀请",
    } });
    client.send(JSON.stringify({ echo: invitation.echo, status: "ok", retcode: 0 }));
    expect(await send("#群审核能力 测试", { user_id: 51 })).toMatchObject({ group_id: 77, message: "无审核能力" });
    expect(await send("#群审核能力 测试", { message_type: "private" })).toMatchObject({ user_id: 42, message: "无审核能力" });
    const review = nextFrame();
    client.send(JSON.stringify({ ...event, message_type: "private", sub_type: "friend", user_id: 51, message: "#群审核能力 测试" }));
    const decision = await review;
    expect(decision).toMatchObject({ action: "set_group_add_request", params: {
      flag: "test-event", sub_type: "invite", approve: false, reason: "测试",
    } });
    const denial = nextFrame();
    client.send(JSON.stringify({ echo: decision.echo, status: "failed", retcode: 1403 }));
    expect(await denial).toMatchObject({ action: "send_msg", params: {
      message_type: "private", user_id: 51, message: "审核被拒绝",
    } });

    const groupRequest = { ...invited, group_id: 91, sub_type: "add", flag: "opaque-request" };
    const groupNotificationFrame = nextFrame();
    client.send(JSON.stringify(groupRequest));
    const groupNotification = await groupNotificationFrame;
    const notification = (groupNotification.params as { message: string }).message;
    expect(groupNotification).toMatchObject({ action: "send_msg", params: {
      message_type: "private", user_id: 51,
    } });
    expect(notification).toContain("待审核群请求");
    expect(notification).not.toContain(groupRequest.flag);
    const requestId = /#同意入群 ([a-f0-9]{12})/u.exec(notification)?.[1];
    expect(requestId).toBeDefined();
    client.send(JSON.stringify({ echo: groupNotification.echo, status: "ok", retcode: 0 }));
    const privateOwner = { message_type: "private", sub_type: "friend", user_id: 51 };
    expect(await send("#入群申请", privateOwner)).toMatchObject({ message: expect.stringContaining(requestId!) });
    expect(await send(`#同意入群 ${requestId}`, { user_id: 51 })).toMatchObject({
      group_id: 77, message: expect.stringContaining("主人私聊"),
    });

    const groupReviewFrame = nextFrame();
    client.send(JSON.stringify({ ...event, ...privateOwner, message: `#同意入群 ${requestId}` }));
    const groupReview = await groupReviewFrame;
    expect(groupReview).toMatchObject({ action: "set_group_add_request", params: {
      flag: groupRequest.flag, sub_type: "add", approve: true,
    } });
    const decisionReply = nextFrame();
    client.send(JSON.stringify({ echo: groupReview.echo, status: "ok", retcode: 0 }));
    expect(await decisionReply).toMatchObject({ action: "send_msg", params: {
      message_type: "private", user_id: 51, message: "已同意群请求。",
    } });
    client.send(JSON.stringify(groupRequest));
    await Bun.sleep(1_020);
    expect(await send("#入群申请", privateOwner)).toMatchObject({ message: "当前没有待审核的群请求。" });

    const joinEvent = {
      post_type: "notice", notice_type: "group_increase", sub_type: "invite", self_id: 99,
      user_id: 43, group_id: 77, operator_id: 51, member: { nickname: "莲" },
    };
    const lookupFrame = nextFrame();
    client.send(JSON.stringify({ ...joinEvent, group_id: 0 }));
    client.send(JSON.stringify(joinEvent));
    const lookup = await lookupFrame;
    expect(lookup).toMatchObject({ action: "get_group_info", params: { group_id: 77 } });
    const welcomeFrame = nextFrame();
    client.send(JSON.stringify({ echo: lookup.echo, status: "ok", retcode: 0, data: { group_name: "测试群" } }));
    const welcome = await welcomeFrame;
    expect(welcome).toMatchObject({ action: "send_msg", params: { group_id: 77, message: [
      { type: "image", data: { file: "https://example.invalid/join.jpg" } },
    ] } });
    const fallbackFrame = nextFrame();
    client.send(JSON.stringify({ echo: welcome.echo, status: "failed", retcode: 100 }));
    const fallback = await fallbackFrame;
    expect(fallback).toMatchObject({ action: "send_msg", params: { group_id: 77, message: JSON.stringify({
      type: "group", change: "increase", action: "invite", bot: 99, user: 43, inviter: 51,
      member: { nickname: "莲" }, group: "测试群",
    }) } });
    client.send(JSON.stringify({ echo: fallback.echo, status: "ok", retcode: 0 }));

    const leaveFrame = nextFrame();
    client.send(JSON.stringify({ ...joinEvent, user_id: 99, notice_type: "group_decrease", sub_type: "kick_me" }));
    const leave = await leaveFrame;
    expect(leave).toMatchObject({ action: "send_msg", params: { group_id: 77, message: "kick_me 51" } });
    client.send(JSON.stringify({ echo: leave.echo, status: "ok", retcode: 0 }));

    const actualJoin = { ...joinEvent, group_id: 78 };
    const actualGroupFrame = nextFrame();
    client.send(JSON.stringify({ ...actualJoin, user_id: 99 }));
    client.send(JSON.stringify(actualJoin));
    const actualGroup = await actualGroupFrame;
    expect(actualGroup).toMatchObject({ action: "get_group_info", params: { group_id: 78 } });
    const actualWelcomeFrame = nextFrame();
    client.send(JSON.stringify({ echo: actualGroup.echo, status: "ok", retcode: 0, data: { group_name: "图鉴群" } }));
    const actualWelcome = await actualWelcomeFrame;
    const welcomeBody = [
      { type: "text", data: { text: "🌸 欢迎来到「图鉴群」\n\n" } },
      { type: "at", data: { qq: "43" } },
      { type: "text", data: { text: " 欢迎加入～\n先看看群公告，有问题随时交流。" } },
    ];
    const avatar = { type: "image", data: { file: "https://q1.qlogo.cn/g?b=qq&nk=43&s=100" } };
    const newline = { type: "text", data: { text: "\n" } };
    expect(actualWelcome).toMatchObject({ action: "send_msg", params: { group_id: 78,
      message: [avatar, newline, ...welcomeBody],
    } });
    const actualFallbackFrame = nextFrame();
    client.send(JSON.stringify({ echo: actualWelcome.echo, status: "failed", retcode: 100 }));
    const actualFallback = await actualFallbackFrame;
    expect(actualFallback).toMatchObject({ action: "send_msg", params: { group_id: 78, message: welcomeBody } });
    client.send(JSON.stringify({ echo: actualFallback.echo, status: "ok", retcode: 0 }));
    client.send(JSON.stringify({ ...actualJoin, user_id: 44 }));
    expect(await send("#状态")).toMatchObject({
      group_id: 77, message: expect.stringContaining("Lotus-Yunzai 正在运行"),
    });

    const actualLeaveFrame = nextFrame();
    client.send(JSON.stringify({ ...actualJoin, notice_type: "group_decrease", sub_type: "kick" }));
    const actualLeave = await actualLeaveFrame;
    expect(actualLeave).toMatchObject({ action: "send_msg", params: { group_id: 78, message: [
      avatar, newline, { type: "text", data: { text: "📋 成员变动\n\n莲（43） 已被移出本群。" } },
    ] } });
    client.send(JSON.stringify({ echo: actualLeave.echo, status: "ok", retcode: 0 }));

    const sendForRecall = nextFrame();
    client.send(JSON.stringify({ ...event, user_id: 51, message: "#回复撤回", message_id: 600 }));
    const pendingRecall = await sendForRecall;
    expect(pendingRecall).toMatchObject({ action: "send_msg", params: { group_id: 77, message: [
      { type: "reply", data: { id: "600" } },
      { type: "at", data: { qq: "51" } },
      { type: "text", data: { text: "\n" } },
      { type: "text", data: { text: "测试撤回" } },
    ] } });
    function awaitDeletions() {
      const { promise, resolve } = Promise.withResolvers<Array<Record<string, unknown>>>();
      const frames: Array<Record<string, unknown>> = [];
      function collect({ data }: MessageEvent) {
        const frame = JSON.parse(data);
        if (frame.action !== "delete_msg") return;
        frames.push(frame);
        client.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0 }));
        if (frames.length === 2) {
          client.removeEventListener("message", collect);
          resolve(frames);
        }
      }
      client.addEventListener("message", collect);
      return promise;
    }

    const deletions = awaitDeletions();
    client.send(JSON.stringify({ echo: pendingRecall.echo, status: "ok", retcode: 0, data: { message_id: 601 } }));
    expect((await deletions).map((frame) => frame.params)).toEqual([{ message_id: 601 }, { message_id: 600 }]);

    expect(await send("#复读")).toMatchObject({ group_id: 77, message: "暂无权限执行此指令。" });
    expect(await send("#复读", { user_id: 51 })).toMatchObject({ group_id: 77, message: [
      { type: "at", data: { qq: "51" } },
      { type: "text", data: { text: "\n" } },
      { type: "text", data: { text: "请发送要复读的内容" } },
    ] });
    expect(await send("#状态")).toMatchObject({
      group_id: 77, message: expect.stringContaining("Lotus-Yunzai 正在运行"),
    });
    const repeatMessage = [
      { type: "text", data: { text: "带表情的复读" } },
      { type: "face", data: { id: "14" } },
    ];
    const repeatFrame = nextFrame();
    client.send(JSON.stringify({ ...event, user_id: 51, message: repeatMessage, message_id: 602 }));
    const repeated = await repeatFrame;
    expect(repeated).toMatchObject({ action: "send_msg", params: { group_id: 77, message: repeatMessage } });
    const repeatDeletions = awaitDeletions();
    client.send(JSON.stringify({ echo: repeated.echo, status: "ok", retcode: 0, data: { message_id: 603 } }));
    expect((await repeatDeletions).map((frame) => frame.params)).toEqual([{ message_id: 603 }, { message_id: 602 }]);

    const automatic = nextFrame();
    client.send(JSON.stringify({ ...event, user_id: 42, message: "OneBot 自动复读", message_id: 604 }));
    client.send(JSON.stringify({ ...event, user_id: 51, message: "OneBot 自动复读", message_id: 605 }));
    const autoRepeat = await automatic;
    expect(autoRepeat).toMatchObject({ action: "send_msg", params: { group_id: 77, message: [
      { type: "text", data: { text: "OneBot 自动复读" } },
    ] } });
    client.send(JSON.stringify({ echo: autoRepeat.echo, status: "ok", retcode: 0, data: { message_id: 606 } }));

    expect(await send("#改群名片拒绝")).toMatchObject({ group_id: 77, message: "❎ 该命令仅限主人可用" });
    const cardRole = nextFrame();
    client.send(JSON.stringify({ ...event, user_id: 51, message: "#改群名片新名片", message_id: 607 }));
    const lookupCardRole = await cardRole;
    expect(lookupCardRole).toMatchObject({ action: "get_group_member_info", params: { group_id: 77, user_id: 99 } });
    const card = nextFrame();
    client.send(JSON.stringify({ echo: lookupCardRole.echo, status: "ok", retcode: 0, data: {
      group_id: 77, user_id: 99, role: "admin",
    } }));
    const settingCard = await card;
    expect(settingCard).toMatchObject({ action: "set_group_card", params: { group_id: 77, user_id: 99, card: "新名片" } });
    const savedCard = nextFrame();
    client.send(JSON.stringify({ echo: settingCard.echo, status: "ok", retcode: 0 }));
    expect(await savedCard).toMatchObject({ action: "send_msg", params: { group_id: 77, message: "✅ 群名片修改成功" } });

    const friendRequest = nextFrame();
    client.send(JSON.stringify({ ...event, message: "赞我" }));
    const friends = await friendRequest;
    expect(friends).toMatchObject({ action: "get_friend_list", params: {} });
    const likeRequest = nextFrame();
    client.send(JSON.stringify({ echo: friends.echo, status: "ok", retcode: 0, data: [{ user_id: 42 }] }));
    const like = await likeRequest;
    expect(like).toMatchObject({ action: "send_like", params: { user_id: 42, times: 3 } });
    const likeReply = (text: string) => [
      { type: "reply", data: { id: String(event.message_id) } }, { type: "text", data: { text } },
    ];
    const confirmation = nextFrame();
    client.send(JSON.stringify({ echo: "unrelated", status: "failed", retcode: 100 }));
    client.send(JSON.stringify({ echo: like.echo, status: "ok", retcode: 0 }));
    expect(await confirmation).toMatchObject({ action: "send_msg", params: { group_id: 77, message: likeReply("确认 3") } });

    const privateLike = nextFrame();
    client.send(JSON.stringify({ ...event, message_type: "private", sub_type: "friend", message: "#赞我" }));
    const refused = await privateLike;
    expect(refused).toMatchObject({ action: "send_like", params: { user_id: 42 } });
    const rejection = nextFrame();
    client.send(JSON.stringify({ echo: refused.echo, status: "failed", retcode: 1404 }));
    expect(await rejection).toMatchObject({ action: "send_msg", params: { user_id: 42, message: likeReply("协议拒绝") } });
    expect(await send("#状态", { message_type: "private", sub_type: "friend" })).toMatchObject({
      user_id: 42, message: expect.stringContaining("Lotus-Yunzai 正在运行"),
    });

    const settingsUrl = new URL("/panel/api/settings/group/likes", http);
    const settingsHeaders = { Authorization: "Bearer group-settings-fixture" };
    expect((await fetch(settingsUrl)).status).toBe(401);
    const original = await (await fetch(settingsUrl, { headers: settingsHeaders })).json() as {
      revision: string; settings: { count: number; successMsg: string };
    };
    expect(original.settings).toMatchObject({ count: 3, successMsg: "确认 {{thumbUpNum}}" });
    const saveSettings = (revision: string, patch: object) => fetch(settingsUrl, {
      method: "PUT", headers: { ...settingsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ revision, patch }),
    });
    expect((await saveSettings(original.revision, { count: 20 })).status).toBe(400);
    const changed = await saveSettings(original.revision, { count: 4 });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ settings: { count: 4, successMsg: "确认 {{thumbUpNum}}" } });
    expect((await saveSettings(original.revision, { count: 5 })).status).toBe(409);
    await Bun.sleep(1_020);
    const nextLike = nextFrame();
    client.send(JSON.stringify({ ...event, message_type: "private", sub_type: "friend", message: "#赞我" }));
    const updatedLike = await nextLike;
    expect(updatedLike).toMatchObject({ action: "send_like", params: { user_id: 42, times: 4 } });
    const afterChange = nextFrame();
    client.send(JSON.stringify({ echo: updatedLike.echo, status: "ok", retcode: 0 }));
    expect(await afterChange).toMatchObject({ action: "send_msg", params: { user_id: 42, message: likeReply("确认 4") } });

    client.close();
    backend.kill();
    await backend.exited;
    const stderr = await new Response(backend.stderr).text();
    expect(stderr).toContain("拒绝加载 miao-plugin");
    expect(stderr).not.toContain("被拒载的旧入口已执行");
    expect(stderr).toContain("OneBot 插件已清理");
    const logDirectory = join(root, "logs");
    const logs = await Promise.all([...new Bun.Glob("command.*.log").scanSync(logDirectory)]
      .map(file => Bun.file(join(logDirectory, file)).text()));
    expect(logs.join("\n")).toContain("[INFO] V3 夹具载入");
    expect(logs.join("\n")).toContain("[MARK] V3 夹具查询完成");
  } finally {
    upstream.stop(true);
    for (const gateway of sockets) gateway.close();
    host?.kill();
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);

test("V3 初始化失败和跳过会清理资源，正常退出按初始化的反序清理", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-init-"));
  try {
    await copyHost(root);
    const plugins = join(root, "plugins");
    await mkdir(plugins, { recursive: true });

    await writeFile(join(plugins, "a-rollback.js"), `
      export const apps = {
        first: class extends plugin {
          constructor() {
            super({ rule: [{ reg: "^#回滚$", fnc: "handle" }] });
          }
          async init() {
            await Promise.resolve();
            this.addCleanup(() => console.log("trace:rollback-first"));
          }
          handle() { return this.reply("不应执行回滚规则"); }
        },
        broken: class extends plugin {
          init() {
            this.addCleanup(() => console.log("trace:rollback-broken"));
            this.addCleanup(() => { throw new Error("清理失败样例"); });
            throw new Error("初始化失败样例");
          }
        }
      };
    `);
    await writeFile(join(plugins, "b-skip.js"), `
      export default class extends plugin {
        constructor() { super({ rule: [{ reg: "^#跳过$", fnc: "handle" }] }); }
        init() {
          this.addCleanup(() => console.log("trace:skip"));
          return "return";
        }
        handle() { return this.reply("不应执行跳过规则"); }
      };
    `);
    await writeFile(join(plugins, "c-active.js"), `
      export default class extends plugin {
        constructor() { super({ rule: [{ reg: "^#初始化$", fnc: "handle" }] }); }
        init() {
          this.addCleanup(() => console.log("trace:active-first"));
          const timer = setInterval(() => {}, 60_000);
          this.addCleanup(() => {
            clearInterval(timer);
            console.log("trace:active-second");
          });
          console.log("trace:init");
        }
        handle() { return this.reply("trace:dispatch"); }
      };
    `);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/server.yaml"), "onebot_enable: false\n");
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root,
      env: { PATH: process.env.PATH },
      stdin: new Blob(["#回滚\n#跳过\n#初始化\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    let result;
    try {
      result = await Promise.all([
        new Response(host.stdout).text(),
        new Response(host.stderr).text(),
        host.exited,
      ]);
    } finally {
      if (host.exitCode === null) host.kill("SIGKILL");
    }
    const [stdout, stderr, exit] = result;
    expect(exit).toBe(0);
    expect(stderr).toContain("初始化失败样例");
    expect(stderr).toContain("清理失败样例");
    expect(stderr).toContain("插件初始化请求跳过");
    expect(plainOutput(stdout)).not.toContain("不应执行");
    expect(plainOutput(stdout).split("\n").filter((line) => line.startsWith("trace:"))).toEqual([
      "trace:rollback-broken", "trace:rollback-first", "trace:skip",
      "trace:init", "trace:dispatch", "trace:active-second", "trace:active-first",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("V3 Handler 由宿主按优先级调用，初始化回滚不会留下注册", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-handler-"));
  try {
    await copyHost(root);
    const plugins = join(root, "plugins");
    await mkdir(plugins, { recursive: true });
    await writeFile(join(plugins, "a-failed.js"), `
      import Handler from "../lib/plugins/handler.js";
      export const apps = {
        first: class extends plugin {
          constructor() {
            super({ handler: [{ key: "fixture.failed-class", fn: "provide" }] });
          }
          init() { Handler.add({ ns: "init", key: "fixture.failed-init", fn: () => "残留" }); }
          provide() { return "残留"; }
        },
        second: class extends plugin {
          init() { throw new Error("Handler 初始化回滚样例"); }
        }
      };
    `);
    await writeFile(join(plugins, "b-registered.js"), `
      import Handler from "../lib/plugins/handler.js";
      export const apps = {
        second: class extends plugin {
          constructor() {
            super({ priority: 20, handler: {
              answer: { key: "fixture.answer", fn: "answer" }
            } });
          }
          async init() {
            await Promise.resolve();
            Handler.add({ ns: "init", event: "fixture.answer", fn: () => "最后", priority: 30 });
          }
          answer(e, args) { return this.name + ":" + e.msg + ":" + args; }
        },
        first: class extends plugin {
          constructor() {
            super({ priority: 100, handler: [{ key: "fixture.answer", fn: "offer", priority: 10 }] });
          }
          offer(e, args, next) { console.log("第一项交给下一项"); next(); }
        }
      };
    `);
    await writeFile(join(plugins, "c-caller.js"), `
      import Handler from "../lib/plugins/handler.js";
      export default class extends plugin {
        constructor() {
          super({ name: "调用方", rule: [
            { reg: "^#调用$", fnc: "run" },
            { reg: "^#旧验证$", fnc: "unsupported" },
            { reg: "^#旧验证全部$", fnc: "unsupportedAll" }
          ] });
        }
        async run(e) {
          Handler.del("init");
          this.reply(await Handler.call("fixture.answer", e, "参数"));
          this.reply(await Handler.callAll("fixture.answer", e, "参数"));
          return this.reply(JSON.stringify([
            Handler.has("fixture.failed-init"), Handler.has("fixture.failed-class"),
            Handler.has("mys.req.err"), Handler.has(" mys.req.err "),
            Handler.has("fixture.rolled-back-unsupported")
          ]));
        }
        unsupported(e) { return Handler.call("mys.req.err", e, { cookie: "cookie-marker" }); }
        unsupportedAll(e) { return Handler.callAll(" MYS.REQ.ERR ", e); }
      };
    `);
    await writeFile(join(plugins, "d-unsupported-class.js"), `
      export default class extends plugin {
        constructor() { super({ handler: [{ key: "mys.req.err", fn: "verify" }] }); }
        verify() { console.log("不应运行旧验证处理器"); }
      };
    `);
    await writeFile(join(plugins, "e-unsupported-init.js"), `
      import Handler from "../lib/plugins/handler.js";
      export default class extends plugin {
        init() {
          Handler.add({ key: "fixture.rolled-back-unsupported", fn: () => "残留" });
          Handler.add({ event: " mys.req.err ", fn: () => "不应接管" });
        }
      };
    `);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/server.yaml"), "onebot_enable: false\n");
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root,
      env: { PATH: process.env.PATH },
      stdin: new Blob(["#旧验证\n#旧验证全部\n#调用\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited,
    ]);
    expect(exit).toBe(0);
    const unsupported = "旧接口 mys.req.err 不受支持，插件需要适配 Lotus Yunzai 才能使用。";
    expect(plainOutput(stdout).trim().split("\n").slice(-7)).toEqual([
      unsupported, unsupported,
      "第一项交给下一项", "未命名插件:#调用:参数",
      "第一项交给下一项", "最后", "[false,false,false,false,false]",
    ]);
    expect(stderr).toContain("Handler 初始化回滚样例");
    expect(stderr).toContain("d-unsupported-class.js");
    expect(stderr).toContain("e-unsupported-init.js");
    expect(stderr.split(unsupported)).toHaveLength(5);
    expect(stdout + stderr).not.toContain("cookie-marker");
    expect(stdout + stderr).not.toContain("不应运行旧验证处理器");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("V3 定时任务去重，调度失败回滚，退出等待正在运行的任务", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-task-"));
  try {
    await copyHost(root);
    const plugins = join(root, "plugins");
    await mkdir(plugins, { recursive: true });
    await writeFile(join(plugins, "a-invalid.js"), `
      export default class extends plugin {
        constructor() {
          super({ task: [
            { name: "回滚样例", cron: "* * * * * *", fnc: () => console.log("不应运行") },
            { name: "无效样例", cron: "70 * * * * *", fnc: () => {} },
          ] });
        }
        init() { this.addCleanup(() => console.log("trace:rollback")); }
      };
    `);
    await writeFile(join(plugins, "b-tasks.js"), `
      import Handler from "../lib/plugins/handler.js";
      export default class extends plugin {
        constructor() {
          super({ name: "任务样例", task: [
            { name: "秒任务", cron: "* * * * * *", fnc: "tick", log: false },
            { name: "秒任务", cron: " *  * * * * * ", fnc: () => console.log("不应重复") },
            { name: "分任务", cron: "* * * * *", fnc: () => {} },
          ] });
        }
        init() {
          Handler.add({ key: "fixture.schedule", fn: () => "可调用" });
          this.addCleanup(() => console.log("trace:cleanup"));
        }
        async tick() {
          console.log("trace:start:" + this.name);
          await Bun.sleep(1700);
          console.log("trace:end:" + await Handler.call("fixture.schedule"));
        }
      };
    `);

    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root,
      env: { LOTUS_HTTP_PORT: "0", PATH: process.env.PATH, LOTUS_ONEBOT_TOKEN: "test-token", LOTUS_ONEBOT_PORT: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => host.kill("SIGKILL"), 5_000);
    const errors = new Response(host.stderr).text();
    const decoder = new TextDecoder();
    let stdout = "";
    let signalled = false;
    try {
      for await (const chunk of host.stdout) {
        stdout += decoder.decode(chunk, { stream: true });
        if (!signalled && stdout.includes("trace:start:任务样例")) {
          signalled = true;
          setTimeout(() => { if (host.exitCode === null) host.kill("SIGTERM"); }, 1100);
        }
      }
      expect(await host.exited).toBe(143);
      const stderr = await errors;
      expect(stderr).toContain("任务 无效样例 的 cron 无效");
      expect(stderr).toContain("跳过重复任务 秒任务");
      expect(plainOutput(stdout)).not.toContain("不应");
      expect(plainOutput(stdout).split("\n").filter((line) => line.startsWith("trace:"))).toEqual([
        "trace:rollback", "trace:start:任务样例", "trace:end:可调用", "trace:cleanup",
      ]);
    } finally {
      clearTimeout(timeout);
      if (host.exitCode === null) host.kill("SIGKILL");
      await host.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 7_000);

test("宿主启动期间停止，清理已加载和正在初始化的模块", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-plugin-shutdown-"));
  try {
    await copyHost(root);
    for (const name of ["a-loaded", "b-pending", "c-next"]) {
      const path = join(root, "plugins", name);
      await mkdir(path);
      await writeFile(join(path, "package.json"), JSON.stringify({ name, lotusYunzai: { entry: "./index.js" } }));
    }
    await writeFile(join(root, "plugins/a-loaded/index.js"), `
      export default { commands: {}, async dispose() { await Bun.sleep(20); console.log("trace:dispose-loaded"); } };
    `);
    await writeFile(join(root, "plugins/b-pending/index.js"), `
      export default { commands: {}, async dispose() { await Bun.sleep(25); console.log("trace:dispose-pending"); } };
      export const apps = { pending: class extends plugin {
        async init() {
          this.addCleanup(() => { console.log("trace:dispose-legacy"); });
          console.log("trace:pending");
          await new Promise(() => {});
        }
      } };
    `);
    await writeFile(join(root, "plugins/c-next/index.js"), `console.log("trace:unexpected-entry");`);
    const child = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, env: { LOTUS_HTTP_PORT: "0", PATH: process.env.PATH }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    const errors = new Response(child.stderr).text();
    const decoder = new TextDecoder();
    let output = "";
    let signalled = false;
    try {
      for await (const chunk of child.stdout) {
        output += decoder.decode(chunk, { stream: true });
        if (!signalled && output.includes("trace:pending")) {
          signalled = true;
          child.kill("SIGTERM");
        }
      }
      expect(await child.exited).toBe(143);
      expect(await errors).toBe("");
      expect(output).not.toContain("Lotus-Yunzai 已启动");
      expect(plainOutput(output).split("\n").filter((line) => line.startsWith("trace:"))).toEqual([
        "trace:pending", "trace:dispose-legacy", "trace:dispose-pending", "trace:dispose-loaded",
      ]);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 7_000);
