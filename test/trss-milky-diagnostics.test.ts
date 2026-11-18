import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const milkyToken = "milky-diagnostics-fixture";
const oneBotToken = "onebot-diagnostics-fixture";
const milkyId = 99;
const oneBotId = 77;

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
  let logins = 0;
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
      return new Response(null, { status: 404 });
    },
    websocket: {
      message() {},
      ping(ws) { heartbeat.resolve(ws); },
    },
  });
  return { server, upgrading, releaseUpgrade, heartbeat, reconnecting, releaseReconnect };
}

async function bindOneBot(endpoint: string) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(endpoint, {
    headers: {
      Authorization: `Bearer ${oneBotToken}`, "X-Client-Role": "Universal", "X-Self-ID": String(oneBotId),
    },
  });
  try {
    const status = await deadline(new Promise<{ action: string; params: { message: string } }>((resolve, reject) => {
      socket.addEventListener("message", ({ data }) => resolve(JSON.parse(data)), { once: true });
      socket.addEventListener("error", () => reject(new Error("OneBot 诊断夹具连接失败。")), { once: true });
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        post_type: "message", message_type: "private", sub_type: "friend", self_id: oneBotId, user_id: 42, message: "#状态",
      })), { once: true });
    }), "OneBot 诊断夹具未收到状态回复。");
    expect(status).toMatchObject({
      action: "send_msg", params: { message: expect.stringContaining("Lotus-Yunzai 正在运行") },
    });
    return socket;
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
      const section = /账号在线时长\r?\n([\s\S]*?)\r?\n\r?\n插件加载用时/u.exec(text)?.[1];
      if (!section) throw new Error("授权终端诊断缺少账号在线时长。\n" + text);
      return section.split(/\r?\n/u);
    },
    close() { reader.releaseLock(); },
  };
}

test("授权终端诊断按实际事件连接展示 Milky 和 OneBot 账号", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-diagnostics-"));
  const mock = gateway();
  let oneBot: WebSocket | undefined;
  try {
    await copyHost(root);
    await mkdir(join(root, "config", "config"), { recursive: true });
    await writeFile(join(root, "config", "config", "other.yaml"), 'master: ["stdin:stdin"]\n');
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.port}`,
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
      expect(online).toHaveLength(2);
      expect(online).toContainEqual(oneBotRow);
      const milkyRow = online.find((row) => row.includes("Milky"));
      expect(milkyRow).toMatch(new RegExp(`\\b${milkyId}\\b`, "u"));
      expect(milkyRow).toMatch(/\d+ 秒/u);

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
    oneBot?.close();
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
