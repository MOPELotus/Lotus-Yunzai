import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginProbeTokenEnvironment } from "../lib/plugin-load-progress.ts";
import { copyHost } from "./host-fixture.ts";

const token = "milky-ws-fixture";
const httpToken = "milky-ws-http-fixture";
const prefix = "/prefix";
const groupId = 77;
const senderId = 42;
const command = "#MilkyWS夹具";
const stamp = 1_700_000_000;
const accounts = [99, 100] as const;

interface Call {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
  body?: unknown;
  pluginReady?: boolean;
}

function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function gateway(readyFile: string) {
  const calls: Call[] = [];
  const sockets = [Promise.withResolvers<Bun.ServerWebSocket<number>>(), Promise.withResolvers<Bun.ServerWebSocket<number>>()];
  const replies = [Promise.withResolvers<Call>(), Promise.withResolvers<Call>()];
  const heartbeat = Promise.withResolvers<void>();
  const activity = Promise.withResolvers<void>();
  let connections = 0;
  let pings = 0;
  let loginCount = 0;
  let sends = 0;
  const server = Bun.serve<number>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, gatewayServer) {
      activity.resolve();
      const url = new URL(request.url);
      const call: Call = {
        method: request.method, path: url.pathname, query: url.search,
        authorization: request.headers.get("Authorization"),
      };
      calls.push(call);
      if (call.authorization !== `Bearer ${token}` || call.query) return new Response(null, { status: 401 });
      if (call.path === `${prefix}/event` && call.method === "GET") {
        if (gatewayServer.upgrade(request, { data: connections++ })) return;
        return new Response(null, { status: 426 });
      }
      if (call.method !== "POST") return new Response(null, { status: 405 });
      call.body = await request.json();
      if (call.path === `${prefix}/api/get_login_info`) {
        call.pluginReady = await Bun.file(readyFile).exists();
        const uin = accounts[loginCount++];
        if (!uin) return Response.json({ status: "failed", retcode: -403 });
        return Response.json({ status: "ok", retcode: 0, data: { uin, nickname: `夹具 ${uin}` } });
      }
      if (call.path === `${prefix}/api/send_group_message`) {
        replies[sends++]?.resolve(call);
        return Response.json({ status: "ok", retcode: 0, data: { message_seq: 200 + sends, time: stamp } });
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(socket) { sockets[socket.data]?.resolve(socket); },
      message() {},
      ping(socket) {
        if (socket.data === 0 && ++pings === 2) heartbeat.resolve();
      },
    },
  });
  return { server, calls, sockets, replies, heartbeat, activity };
}

async function hostReady(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const part = await reader.read();
      if (part.done) throw new Error("Milky WS 测试宿主未完成启动。\n" + output);
      output += decoder.decode(part.value, { stream: true });
    }
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function withHost(probe: boolean, run: (mock: ReturnType<typeof gateway>, output: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-ws-"));
  const readyFile = join(root, "plugin-ready");
  const mock = gateway(readyFile);
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.port}`, `prefix: ${prefix}`,
      `access_token: ${token}`, "ws:", "  reconnect_interval: 0.05", "  heartbeat: 0.2",
    ].join("\n") + "\n");
    await writeFile(join(root, "plugins", "milky-ws-fixture.js"), `
      export default class extends plugin {
        constructor() {
          super({ event: "message.group", rule: [{ reg: "^${command}$", fnc: "respond" }] });
        }
        async init() {
          await Bun.write(${JSON.stringify(readyFile)}, "ready");
        }
        respond(e) {
          return e.reply("群 " + e.group_id + " 成员 " + e.user_id + " 机器人 " + e.self_id);
        }
      }
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        ...(probe ? {
          LOTUS_HTTP_PORT: "0", LOTUS_HTTP_TOKEN: httpToken, [pluginProbeTokenEnvironment]: "milky-ws-health-fixture",
        } : {}),
      },
    });
    const stderr = new Response(host.stderr).text();
    try {
      await run(mock, await deadline(hostReady(host.stdout), "Milky WS 测试宿主启动超时。"));
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
      try {
        await deadline(host.exited, "Milky WS 测试宿主未响应 SIGTERM。");
      } finally {
        if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
        await host.exited;
      }
    }
    expect(host.exitCode).toBe(143);
    expect(await stderr).not.toContain(token);
  } finally {
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

function groupMessage(socket: Bun.ServerWebSocket<number>, selfId: number, sequence: number) {
  socket.send(JSON.stringify({
    time: stamp,
    self_id: selfId,
    event_type: "message_receive",
    data: {
      message_scene: "group",
      peer_id: groupId,
      sender_id: senderId,
      message_seq: sequence,
      time: stamp,
      segments: [{ type: "text", data: { text: command } }],
    },
  }));
}

test("Milky 默认建立认证 WebSocket，发送心跳并在断线后重新绑定账号", async () => {
  await withHost(false, async (mock, output) => {
    expect(output).not.toContain("HTTP 正在监听");
    for (const [index, account] of accounts.entries()) {
      const socket = await deadline(mock.sockets[index]!.promise, "Milky 事件 WebSocket 未连接。");
      groupMessage(socket, accounts[1 - index]!, 10 + index);
      groupMessage(socket, account, 20 + index);
      const reply = await deadline(mock.replies[index]!.promise, "未收到 V3 插件的 Milky 群消息回复。");
      expect(reply.body).toEqual({
        group_id: groupId, message: [{ type: "text", data: { text: `群 ${groupId} 成员 ${senderId} 机器人 ${account}` } }],
      });
      if (index === 0) {
        await deadline(mock.heartbeat.promise, "Milky 原生 WebSocket 心跳未在同一连接持续发送。");
        socket.close(1012, "fixture reconnect");
      }
    }

    const expectedCalls = [
      { method: "POST", path: `${prefix}/api/get_login_info`, body: {}, pluginReady: true },
      { method: "GET", path: `${prefix}/event` },
      { method: "POST", path: `${prefix}/api/send_group_message`, body: expect.any(Object) },
    ];
    expect(mock.calls).toEqual([...expectedCalls, ...expectedCalls].map((call) => ({
      ...call, authorization: `Bearer ${token}`, query: "",
    })));
  });
}, 12_000);

test("Milky 更新健康探测只启动临时 HTTP，不连接网关或事件 WebSocket", async () => {
  await withHost(true, async (mock, output) => {
    const statusUrl = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+\/status)/u.exec(output)?.[1];
    expect(statusUrl).toBeDefined();
    const status = await fetch(statusUrl!, {
      headers: { Authorization: `Bearer ${httpToken}` }, signal: AbortSignal.timeout(2_000),
    });
    expect(status.status).toBe(200);
    const activity = await Promise.race([mock.activity.promise.then(() => true), Bun.sleep(200).then(() => false)]);
    expect(activity).toBe(false);
    expect(mock.calls).toEqual([]);
  });
}, 8_000);
