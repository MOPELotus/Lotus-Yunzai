import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const milkyToken = "milky-diagnostics-fixture";
const oneBotToken = "onebot-diagnostics-fixture";
const milkyId = 99;
const oneBotId = milkyId;
const owner = 51;
const blockedTip = "私聊诊断限制夹具";
const time = 1_700_000_000;

function accountRows(text: string) {
  const section = /账号在线时长\r?\n([\s\S]*?)\r?\n\r?\n插件加载用时/u.exec(text)?.[1];
  if (!section) throw new Error("诊断回复缺少账号在线时长。\n" + text);
  expect(text).toMatch(/^system　\d+ ms$/mu);
  return section.split(/\r?\n/u);
}

function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function gateway() {
  const upgrading = Promise.withResolvers<void>();
  const releaseUpgrade = Promise.withResolvers<void>();
  const heartbeat = Promise.withResolvers<Bun.ServerWebSocket>();
  const reconnecting = Promise.withResolvers<void>();
  const releaseReconnect = Promise.withResolvers<void>();
  const messages: {
    action: string;
    body: { user_id?: number; group_id?: number; message: { type: "text"; data: { text: string } }[] };
  }[] = [];
  let available = Promise.withResolvers<void>();
  let logins = 0;
  let messageSequence = 0;
  let replySequence = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, gatewayServer) {
      if (request.headers.get("Authorization") !== `Bearer ${milkyToken}`) return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/api/get_login_info") {
        if (++logins > 1) {
          reconnecting.resolve();
          await releaseReconnect.promise;
        }
        return Response.json({ status: "ok", retcode: 0, data: { uin: milkyId, nickname: "诊断夹具" } });
      }
      if (request.method === "GET" && path === "/event") {
        upgrading.resolve();
        await releaseUpgrade.promise;
        if (gatewayServer.upgrade(request)) return;
        return new Response(null, { status: 426 });
      }
      if (request.method === "POST" && (path === "/api/send_private_message" || path === "/api/send_group_message")) {
        messages.push({ action: path.slice("/api/".length), body: await request.json() as (typeof messages)[number]["body"] });
        available.resolve();
        return Response.json({ status: "ok", retcode: 0, data: { message_seq: ++replySequence, time } });
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      message() {},
      ping(ws) { heartbeat.resolve(ws); },
    },
  });
  return {
    server, upgrading, releaseUpgrade, heartbeat, reconnecting, releaseReconnect,
    async command(ws: Bun.ServerWebSocket, text: string, sender_id = owner, group_id?: number) {
      ws.send(JSON.stringify({
        time, self_id: milkyId, event_type: "message_receive",
        data: {
          time, message_seq: ++messageSequence, sender_id, peer_id: group_id ?? sender_id,
          message_scene: group_id === undefined ? "friend" : "group",
          segments: [{ type: "text", data: { text } }],
        },
      }));
      if (!messages.length) await deadline(available.promise, `Milky 未回复 ${text}。`);
      const reply = messages.shift()!;
      if (!messages.length) available = Promise.withResolvers<void>();
      const responseText = reply.body.message[0]?.data?.text;
      if (typeof responseText !== "string") throw new Error("Milky 诊断夹具未收到文本。");
      expect(reply).toEqual({
        action: group_id === undefined ? "send_private_message" : "send_group_message",
        body: {
          ...(group_id === undefined ? { user_id: sender_id } : { group_id }),
          message: [{ type: "text", data: { text: responseText } }],
        },
      });
      return responseText;
    },
  };
}

async function bindOneBot(endpoint: string) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(endpoint, {
    headers: {
      Authorization: `Bearer ${oneBotToken}`, "X-Client-Role": "Universal", "X-Self-ID": String(oneBotId),
    },
  });
  try {
    await deadline(new Promise<void>((resolve, reject) => {
      socket.addEventListener("error", () => reject(new Error("OneBot 诊断夹具连接失败。")), { once: true });
      socket.addEventListener("open", () => resolve(), { once: true });
    }), "OneBot 诊断夹具未连接。");
    let message_id = 0;
    async function command(message: string) {
      const reply = new Promise<{ action: string; params: { message: string } }>((resolve) => {
        socket.addEventListener("message", ({ data }) => resolve(JSON.parse(data)), { once: true });
      });
      socket.send(JSON.stringify({
        post_type: "message", message_type: "private", sub_type: "friend", self_id: oneBotId,
        user_id: owner, message_id: ++message_id, message,
      }));
      const response = await deadline(reply, `OneBot 诊断夹具未回复 ${message}。`);
      expect(response).toMatchObject({ action: "send_msg", params: { user_id: owner } });
      expect(typeof response.params.message).toBe("string");
      return response.params.message;
    }
    expect(await command("#状态")).toContain("Lotus-Yunzai 正在运行");
    return { socket, command };
  } catch (error) {
    socket.close();
    throw error;
  }
}

function terminal(host: Bun.Subprocess<"pipe", "pipe", "pipe">) {
  const reader = host.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  async function readThrough(pattern: RegExp) {
    for (;;) {
      const match = pattern.exec(output);
      if (match) {
        const end = match.index + match[0].length;
        const reply = output.slice(0, end);
        output = output.slice(end);
        return reply;
      }
      const part = await reader.read();
      if (part.done) throw new Error("诊断测试宿主提前退出。\n" + output);
      output += decoder.decode(part.value, { stream: true });
    }
  }

  return {
    readThrough,
    async accounts() {
      host.stdin.write("#诊断\n");
      host.stdin.flush();
      const text = await deadline(readThrough(/(?:^|\n)system　\d+ ms\r?\n/u), "终端诊断未输出。");
      return accountRows(text);
    },
    close() { reader.releaseLock(); },
  };
}

test("Milky 和 OneBot 主人的私聊诊断按协议隔离，终端可查看全部连接", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-diagnostics-"));
  const mock = gateway();
  let oneBot: Awaited<ReturnType<typeof bindOneBot>> | undefined;
  try {
    await copyHost(root);
    await mkdir(join(root, "config", "config"), { recursive: true });
    await writeFile(join(root, "config", "config", "other.yaml"), [
      'master: ["stdin:stdin", "99:51", "100:52"]', "disablePrivate: true", `disableMsg: ${blockedTip}`,
      "disableAdopt: ['^#诊断 ', '^#状态 ', '^#统计 ']",
    ].join("\n") + "\n");
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.url.port}`,
      `access_token: ${milkyToken}`, "ws:", "  reconnect_interval: 0.05", "  heartbeat: 0.1",
    ].join("\n") + "\n");
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: oneBotToken },
    });
    const output = terminal(host);
    const stderr = new Response(host.stderr).text();
    try {
      const startup = await deadline(output.readThrough(/Lotus-Yunzai 已启动[^\n]*\n/u), "诊断测试宿主启动超时。");
      const url = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(startup)?.[0];
      if (!url) throw new Error("诊断测试宿主缺少 OneBot 监听地址。");
      oneBot = await bindOneBot(url);
      await deadline(mock.upgrading.promise, "Milky 未登录并请求事件升级。");
      const oneBotRow = expect.stringMatching(new RegExp(`^${oneBotId}　\\d+ 秒$`, "u"));
      expect(await output.accounts()).toEqual([oneBotRow]);

      mock.releaseUpgrade.resolve();
      const ws = await deadline(mock.heartbeat.promise, "Milky 事件连接未进入心跳。");
      const online = await output.accounts();
      const milkyRow = expect.stringMatching(new RegExp(`^${milkyId}　Milky　\\d+ 秒$`, "u"));
      expect(online).toHaveLength(2);
      expect(online).toEqual(expect.arrayContaining([oneBotRow, milkyRow]));
      for (const query of ["#诊断", "#状态"]) {
        expect(accountRows(await mock.command(ws, query))).toEqual([milkyRow]);
        expect(accountRows(await oneBot.command(query))).toEqual([oneBotRow]);
      }
      expect(await mock.command(ws, "#诊断", 42)).toBe(blockedTip);
      expect(await mock.command(ws, "#状态", 52)).toBe(blockedTip);
      const groups = await mock.command(ws, "#诊断", owner, 77);
      expect(groups).toContain("Lotus-Yunzai 运行诊断");
      expect(groups).not.toContain("账号在线时长");
      expect(groups).not.toContain("插件加载用时");
      for (const query of ["#诊断 夹具", "#状态 夹具"]) {
        const report = await mock.command(ws, query);
        expect(report).toMatch(/^Lotus-Yunzai (?:运行诊断|正在运行)/u);
        expect(report).not.toContain("账号在线时长");
        expect(report).not.toContain("插件加载用时");
      }
      for (const query of ["#统计 机器人 99", "#状态 机器人 99"]) {
        expect(await mock.command(ws, query)).toBe("仅当前机器人的主人可以指定统计对象。");
      }

      ws.close(1012, "fixture disconnect");
      await deadline(mock.reconnecting.promise, "Milky 未重新请求登录。");
      expect(await output.accounts()).toEqual([oneBotRow]);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
      mock.releaseUpgrade.resolve();
      mock.releaseReconnect.resolve();
      await host.exited;
      output.close();
    }
    expect(await stderr).not.toContain(milkyToken);
  } finally {
    oneBot?.socket.close();
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
