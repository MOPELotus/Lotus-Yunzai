import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "command-forward-fixture";
const title = "图册夹具，共 2 页";
const plain = "普通命令回复";
const images = [
  { type: "image", data: { file: "base64://AQID" } },
  { type: "image", data: { file: "base64://BAUG" } },
];

interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: {
    readonly message?: string | readonly object[];
    readonly messages?: readonly object[];
  };
}

interface MilkyFixtureBody {
  readonly message?: readonly { type: string; data: object }[];
  readonly group_id?: number;
  readonly user_id?: number;
  readonly message_seq?: number;
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function readEndpoint(stdout: ReadableStream<Uint8Array>, pattern: RegExp) {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) throw new Error(`合并转发测试宿主未输出监听地址。\n${output}`);
      output += decoder.decode(part.value, { stream: true });
      const endpoint = pattern.exec(output)?.[1];
      if (endpoint) return endpoint;
    }
  } finally {
    reader.releaseLock();
  }
}

function inbox<T>() {
  const frames: T[] = [];
  let ready = Promise.withResolvers<void>();
  return {
    frames,
    push(frame: T) {
      frames.push(frame);
      ready.resolve();
    },
    async next() {
      if (!frames.length) await deadline(ready.promise, "未收到合并转发测试的消息。");
      const frame = frames.shift()!;
      if (!frames.length) ready = Promise.withResolvers<void>();
      return frame;
    },
  };
}

async function writePlugin(root: string) {
  const plugin = join(root, "plugins", "command-forward-fixture");
  await mkdir(plugin, { recursive: true });
  await Promise.all([
    writeFile(join(plugin, "package.json"), JSON.stringify({
      name: "@fixture/command-forward", type: "module", lotusYunzai: { entry: "./index.ts" },
    })),
    writeFile(join(plugin, "index.ts"), `
      export default { commands: {
        "#转发夹具": () => ({ type: "forward", nodes: [${JSON.stringify(title)},
          { type: "image", file: new Uint8Array([1, 2, 3]) },
          { type: "image", file: new Uint8Array([4, 5, 6]) },
        ] }),
        "#定时撤回转发": () => ({ type: "forward", nodes: [${JSON.stringify(title)},
          { type: "image", file: new Uint8Array([1, 2, 3]) },
          { type: "image", file: new Uint8Array([4, 5, 6]) },
        ], recallSeconds: 0.05 }),
        "#定时撤回回复": () => ({ type: "recallable", message: ${JSON.stringify(plain)}, seconds: 0.05 }),
        "#文字夹具": () => ${JSON.stringify(plain)},
      } };
    `),
    writeFile(join(root, "plugins", "legacy-forward-fixture.js"), `
      import common from "../lib/common/common.js";
      import Handler from "../lib/plugins/handler.js";
      export default class extends plugin {
        constructor() {
          super({ name: "V3 转发夹具", rule: [
            { reg: /^#旧版转发$/, fnc: "send" },
            { reg: /^#旧公共转发$/, fnc: "send" },
          ] });
        }
        init() {
          Handler.add({ ns: "primary", key: "fixture.forward.title", fn: () => ${JSON.stringify(title)}, priority: 1 });
          Handler.add({ ns: "alternate", key: "fixture.forward.title", fn: () => "备用标题", priority: 2 });
        }
        async send(e) {
          const { handler } = e.runtime;
          const key = "fixture.forward.title";
          if (!handler.has(key) || await handler.callAll(key, e) !== "备用标题") return false;
          const { makeForwardMsg } = e.msg === "#旧版转发" ? e.runtime.common : common;
          return e.reply(await makeForwardMsg(e, [
            segment.image(new Uint8Array([1, 2, 3])), segment.image(new Uint8Array([4, 5, 6])),
          ], await handler.call(key, e)));
        }
      }
    `),
  ]);
}

function openGateway(endpoint: string) {
  const WebSocketClient = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new WebSocketClient(endpoint, {
    headers: { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99" },
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const messages = inbox<Frame>();
  socket.addEventListener("message", ({ data }) => messages.push(JSON.parse(data)));
  let messageId = 0;
  return {
    socket, opened, ...messages,
    command(message: string, type: "group" | "private" = "group") {
      socket.send(JSON.stringify({ post_type: "message", message_type: type, message_id: ++messageId,
        self_id: 99, user_id: 42, message,
        ...(type === "group" ? { sub_type: "normal", group_id: 77, sender: { role: "member" } }
          : { sub_type: "friend" }),
      }));
    },
    receipt(frame: Frame, status: string, retcode: number, data = { message_id: 100 } as Record<string, unknown>) {
      expect(typeof frame.echo).toBe("string");
      socket.send(JSON.stringify({ echo: frame.echo, status, retcode,
        data: status === "ok" && retcode === 0 ? data : undefined,
      }));
    },
  };
}

test("宿主通过当前 OneBot 会话按顺序发送现代与 V3 指令的合并转发", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-command-forward-"));
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let gateway: ReturnType<typeof openGateway> | undefined;
  try {
    await copyHost(root);
    disableMemberPrewarm(root);
    await writePlugin(root);
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    const stderr = new Response(host.stderr).text();
    const endpoint = await deadline(readEndpoint(host.stdout, /(ws:\/\/127\.0\.0\.1:\d+\/OneBotv11)/u),
      "OneBot 合并转发测试宿主启动超时。");
    const bot = gateway = openGateway(endpoint);
    await deadline(bot.opened, "合并转发测试网关连接超时。");

    async function forward(type: "group" | "private", command = "#转发夹具") {
      bot.command(command, type);
      const frame = await bot.next();
      expect(frame).toMatchObject(type === "group" ? {
        action: "send_group_forward_msg", params: { group_id: 77 },
      } : { action: "send_private_forward_msg", params: { user_id: 42 } });
      expect(frame.params.messages).toEqual([
        [{ type: "text", data: { text: title } }], [images[0]], [images[1]],
      ].map((content) => ({ type: "node", data: { uin: "99", name: "Lotus-Yunzai", content } })));
      return frame;
    }

    bot.receipt(await forward("group"), "ok", 0);
    // 同一机器人和用户的同文请求在群私之间也共用一秒窗口。
    await Bun.sleep(1_050);
    bot.receipt(await forward("private"), "ok", 0);
    bot.receipt(await forward("group", "#旧版转发"), "ok", 0);
    bot.receipt(await forward("private", "#旧公共转发"), "ok", 0);

    await Bun.sleep(1_050);
    bot.receipt(await forward("group"), "failed", 1404);
    for (const message of [title, [images[0]], [images[1]]]) {
      expect(await bot.next()).toMatchObject({ action: "send_msg", params: { group_id: 77, message } });
    }

    await Bun.sleep(1_050);
    bot.receipt(await forward("private"), "ok", 1);
    await Bun.sleep(80);
    expect(bot.frames).toEqual([]);

    bot.command("#文字夹具", "private");
    expect(await bot.next()).toMatchObject({ action: "send_msg", params: { user_id: 42, message: plain } });
    bot.receipt(await forward("group", "#定时撤回转发"), "ok", 0, { message_id: 505 });
    const groupRecall = await bot.next();
    expect(groupRecall).toMatchObject({ action: "delete_msg", params: { message_id: 505 } });
    bot.receipt(groupRecall, "ok", 0);
    bot.command("#定时撤回回复", "private");
    const reply = await bot.next();
    expect(reply).toMatchObject({ action: "send_msg", params: { user_id: 42, message: plain } });
    bot.receipt(reply, "ok", 0, { message_id: 506 });
    const replyRecall = await bot.next();
    expect(replyRecall).toMatchObject({ action: "delete_msg", params: { message_id: 506 } });
    bot.receipt(replyRecall, "ok", 0);
    await Bun.sleep(1_050);
    bot.receipt(await forward("private", "#定时撤回转发"), "ok", 0, { forward_id: "not-a-message-id" });
    await Bun.sleep(100);
    expect(bot.frames).toEqual([]);
    host.kill();
    await deadline(host.exited, "合并转发测试宿主退出超时。");
    expect(await stderr).not.toContain("处理 OneBot 来信失败");
  } finally {
    gateway?.socket.close();
    if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("宿主通过 Milky 在群聊和私聊发送现代与 V3 指令的合并转发", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-command-forward-"));
  const calls = inbox<{ action: string; body: MilkyFixtureBody }>();
  let mode: "accepted" | "rejected" | "unknown" = "accepted";
  let outboundSeq = 100;
  const appGateway = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response(null, { status: 401 });
      }
      const action = new URL(request.url).pathname;
      if (action === "/api/get_login_info") {
        return Response.json({ status: "ok", retcode: 0, data: { uin: 99, nickname: "转发夹具" } });
      }
      const body = await request.json() as MilkyFixtureBody;
      calls.push({ action, body });
      if (body.message?.[0]?.type === "forward") {
        if (mode === "rejected") return Response.json({ status: "failed", retcode: -404 });
        if (mode === "unknown") return Response.json({ status: "ok", retcode: 0, data: {} });
      }
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: ++outboundSeq } });
    },
  });
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await copyHost(root);
    await writePlugin(root);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${appGateway.port}`, "connection: webhook",
      `access_token: ${token}`, "webhook:", "  path: /fixture/forward", "",
    ].join("\n"));
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0" },
    });
    const stderr = new Response(host.stderr).text();
    const endpoint = await deadline(readEndpoint(host.stdout, /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u),
      "Milky 合并转发测试宿主启动超时。");
    const webhook = (event_type: string, data: unknown) => fetch(`${endpoint}/fixture/forward`, {
      method: "POST", signal: AbortSignal.timeout(1_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ self_id: 99, event_type, time: 1_700_000_000, data }),
    });
    const stopAt = performance.now() + 2_000;
    for (;;) {
      const response = await webhook("fixture_unsupported", {});
      if (response.status === 200) break;
      if (response.status !== 503 || performance.now() >= stopAt) throw new Error(`Milky 测试宿主未绑定：${response.status}`);
      await Bun.sleep(20);
    }

    const text = (value: string) => ({ type: "text", data: { text: value } });
    const segments = images.map(({ data }) => ({ type: "image", data: { uri: data.file, sub_type: "normal" } }));
    let inboundSeq = 0;
    async function command(message: string, group: boolean) {
      const response = await webhook("message_receive", {
        message_scene: group ? "group" : "friend", peer_id: group ? 77 : 42, sender_id: 42,
        message_seq: ++inboundSeq, time: 1_700_000_000, segments: [text(message)],
      });
      expect(response.status).toBe(200);
    }
    async function next(group: boolean, message: MilkyFixtureBody["message"]) {
      expect(await calls.next()).toEqual({
        action: group ? "/api/send_group_message" : "/api/send_private_message",
        body: { ...(group ? { group_id: 77 } : { user_id: 42 }), message },
      });
    }
    async function forward(group: boolean, name = "#转发夹具") {
      await command(name, group);
      await next(group, [{ type: "forward", data: {
        messages: [text(title), ...segments].map((segment) => ({
          user_id: 99, sender_name: "Lotus-Yunzai", segments: [segment],
        })),
      } }]);
    }

    await forward(true);
    await forward(false);
    await forward(true, "#旧公共转发");
    await forward(false, "#旧版转发");
    mode = "rejected";
    await forward(true, "#旧版转发");
    for (const segment of [text(title), ...segments]) await next(true, [segment]);
    mode = "unknown";
    await forward(false, "#旧公共转发");
    await Bun.sleep(80);
    expect(calls.frames).toEqual([]);
    await command("#文字夹具", false);
    await next(false, [text(plain)]);
    mode = "accepted";
    await forward(true, "#定时撤回转发");
    const groupSeq = outboundSeq;
    expect(await calls.next()).toEqual({
      action: "/api/recall_group_message", body: { group_id: 77, message_seq: groupSeq },
    });
    await command("#定时撤回回复", false);
    await next(false, [text(plain)]);
    const privateSeq = outboundSeq;
    expect(await calls.next()).toEqual({
      action: "/api/recall_private_message", body: { user_id: 42, message_seq: privateSeq },
    });
    mode = "unknown";
    await forward(false, "#定时撤回转发");
    await Bun.sleep(80);
    expect(calls.frames).toEqual([]);
    await Bun.sleep(100);
    expect(calls.frames).toEqual([]);
    host.kill();
    await deadline(host.exited, "Milky 合并转发测试宿主退出超时。");
    expect(await stderr).not.toContain("处理 Milky");
  } finally {
    if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await host?.exited;
    appGateway.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
