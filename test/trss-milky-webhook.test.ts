import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginProbeTokenEnvironment } from "../lib/plugin-load-progress.ts";
import { copyHost } from "./host-fixture.ts";

const webhookPath = "/fixture/milky-inbound";
const prefix = "/prefix";
const botId = 99;
const senderId = 42;
const groupId = 77;
const timestamp = 1_700_000_000;
const httpToken = "milky-fixture-host-http";
const milkyToken = "milky-fixture-gateway";
const command = "#Milky夹具";

interface GatewayCall {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function readStartup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const part = await reader.read();
      if (part.done) throw new Error("Milky 测试宿主未完成启动。\n" + output);
      output += decoder.decode(part.value, { stream: true });
    }
    const match = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
    if (!match) throw new Error("Milky 测试宿主未输出 HTTP 监听地址。");
    return new URL(match);
  } finally {
    reader.releaseLock();
  }
}

function mockGateway() {
  const calls: GatewayCall[] = [];
  const loginArrived = Promise.withResolvers<GatewayCall>();
  const releaseLogin = Promise.withResolvers<void>();
  const reloginArrived = Promise.withResolvers<void>();
  const releaseRelogin = Promise.withResolvers<void>();
  let loginAttempts = 0;
  const replies = {
    private: Promise.withResolvers<GatewayCall>(),
    group: Promise.withResolvers<GatewayCall>(),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const call: GatewayCall = {
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.json(),
      };
      calls.push(call);
      if (call.method !== "POST" || call.headers.get("Authorization") !== `Bearer ${milkyToken}`) {
        return new Response(null, { status: 401 });
      }
      switch (call.path) {
        case `${prefix}/api/get_login_info`:
          if (++loginAttempts === 1) {
            loginArrived.resolve(call);
            await releaseLogin.promise;
            return Response.json({ status: "failed", retcode: -403, message: "暂未登录" });
          }
          if (loginAttempts === 3) {
            reloginArrived.resolve();
            await releaseRelogin.promise;
          }
          return Response.json({ status: "ok", retcode: 0, data: { uin: botId, nickname: "Milky 夹具" } });
        case `${prefix}/api/send_private_message`:
          replies.private.resolve(call);
          break;
        case `${prefix}/api/send_group_message`:
          replies.group.resolve(call);
          break;
        default:
          return new Response(null, { status: 404 });
      }
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: 100, time: timestamp } });
    },
  });
  return { server, calls, loginArrived, releaseLogin, reloginArrived, releaseRelogin, replies };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function request(url: URL, options: RequestInit = {}) {
  return fetch(url, { signal: AbortSignal.timeout(2_000), ...options });
}

function webhook(
  url: URL, data: unknown, token?: string, contentType = "application/json",
) {
  return request(url, {
    method: "POST",
    headers: { "Content-Type": contentType, ...(token === undefined ? {} : auth(token)) },
    body: JSON.stringify(data),
  });
}

function message(scene: "friend" | "group", selfId = botId) {
  return {
    time: timestamp,
    self_id: selfId,
    event_type: "message_receive",
    data: {
      message_scene: scene,
      peer_id: scene === "friend" ? senderId : groupId,
      message_seq: scene === "friend" ? 11 : 12,
      sender_id: senderId,
      time: timestamp,
      segments: [{ type: "text", data: { text: command } }],
      ...(scene === "friend" ? {
        friend: {
          user_id: senderId, nickname: "好友", sex: "unknown", qid: "", remark: "",
          category: { category_id: 0, category_name: "默认" },
        },
      } : {
        group: {
          group_id: groupId, group_name: "样本群", member_count: 2, max_member_count: 200,
          remark: "", created_time: timestamp, description: "", question: "", announcement: "",
        },
        group_member: {
          user_id: senderId, nickname: "群友", sex: "unknown", group_id: groupId,
          card: "群名片", title: "", level: 1, role: "member", join_time: timestamp, last_sent_time: timestamp,
        },
      }),
    },
  };
}

async function waitForBind(url: URL) {
  const event = { time: timestamp, self_id: botId, event_type: "fixture_unsupported", data: {} };
  const stopAt = performance.now() + 2_000;
  for (;;) {
    const response = await webhook(url, event, milkyToken);
    if (response.status !== 503 || performance.now() >= stopAt) {
      expect(response.status).toBe(200);
      return;
    }
    await Bun.sleep(25);
  }
}

test("Milky Webhook 独立鉴权并按已绑定账号分发好友和群消息", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-webhook-"));
  const gateway = mockGateway();
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true",
      "host: 127.0.0.1",
      `port: ${gateway.server.port}`,
      `prefix: ${prefix}`,
      "connection: webhook",
      `access_token: ${milkyToken}`,
      "ws:",
      "  reconnect_interval: 0.05",
      "webhook:",
      `  path: ${webhookPath}`,
    ].join("\n") + "\n");
    await writeFile(join(root, "plugins", "milky-webhook-fixture.js"), `
      export default class extends plugin {
        constructor() {
          super({ event: "message", rule: [{ reg: "^${command}$", fnc: "echo" }] });
        }
        echo(e) {
          return e.reply(e.isGroup
            ? "群 " + e.group_id + " 成员 " + e.user_id + " 机器人 " + e.self_id
            : "好友 " + e.user_id + " 机器人 " + e.self_id);
        }
      }
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_HTTP_TOKEN: httpToken },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const [origin, login] = await Promise.all([
        deadline(readStartup(host.stdout), "Milky 测试宿主启动超时。"),
        deadline(gateway.loginArrived.promise, "宿主未向 Milky 请求登录信息。"),
      ]);
      expect(login).toMatchObject({ method: "POST", path: `${prefix}/api/get_login_info`, body: {} });
      expect(login.headers.get("Authorization")).toBe(`Bearer ${milkyToken}`);
      expect(login.headers.get("Content-Type")).toMatch(/^application\/json(?:;|$)/u);

      const endpoint = new URL(webhookPath, origin);
      expect((await webhook(endpoint, message("friend"), milkyToken)).status).toBe(503);
      gateway.releaseLogin.resolve();
      await waitForBind(endpoint);

      const status = new URL("/status", origin);
      expect((await request(status, { headers: auth(httpToken) })).status).toBe(200);
      expect((await request(status, { headers: auth(milkyToken) })).status).toBe(401);
      expect((await request(endpoint, { headers: auth(milkyToken) })).status).toBe(405);
      expect((await webhook(endpoint, message("friend"))).status).toBe(401);
      expect((await webhook(endpoint, message("friend"), httpToken)).status).toBe(401);
      const queryOnly = new URL(endpoint);
      queryOnly.searchParams.set("access_token", milkyToken);
      expect((await webhook(queryOnly, message("friend"))).status).toBe(401);
      expect((await webhook(endpoint, message("friend", botId + 1), milkyToken)).status).toBe(403);
      expect((await webhook(endpoint, message("friend"), milkyToken, "text/plain")).status).toBe(415);
      expect((await webhook(endpoint, { self_id: botId }, milkyToken)).status).toBe(400);
      const loginPath = `${prefix}/api/get_login_info`;
      expect(gateway.calls.map(({ path }) => path)).toEqual([loginPath, loginPath]);

      expect((await webhook(endpoint, message("friend"), milkyToken)).status).toBe(200);
      const direct = await deadline(gateway.replies.private.promise, "Milky 好友消息未收到插件回复。");
      expect(direct.body).toEqual({
        user_id: senderId, message: [{ type: "text", data: { text: `好友 ${senderId} 机器人 ${botId}` } }],
      });
      expect((await webhook(endpoint, message("group"), milkyToken)).status).toBe(200);
      const group = await deadline(gateway.replies.group.promise, "Milky 群消息未收到插件回复。");
      expect(group.body).toEqual({
        group_id: groupId, message: [{ type: "text", data: { text: `群 ${groupId} 成员 ${senderId} 机器人 ${botId}` } }],
      });
      expect(gateway.calls.map(({ path }) => path)).toEqual([
        loginPath, loginPath, `${prefix}/api/send_private_message`, `${prefix}/api/send_group_message`,
      ]);
      const offline = { time: timestamp, self_id: botId, event_type: "bot_offline", data: { reason: "fixture" } };
      expect((await webhook(endpoint, offline, milkyToken)).status).toBe(200);
      await deadline(gateway.reloginArrived.promise, "离线事件后未重新查询 Milky 登录。");
      expect((await webhook(endpoint, message("friend"), milkyToken)).status).toBe(503);
      gateway.releaseRelogin.resolve();
      await waitForBind(endpoint);
    } finally {
      gateway.releaseLogin.resolve();
      gateway.releaseRelogin.resolve();
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
    }
    expect(await stderr).not.toContain(milkyToken);

    const probe = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore",
      env: {
        PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_HTTP_TOKEN: httpToken,
        [pluginProbeTokenEnvironment]: "milky-health-fixture",
      },
    });
    const previousCalls = gateway.calls.length;
    try {
      const origin = await deadline(readStartup(probe.stdout), "Milky 健康探测宿主未启动。");
      expect((await webhook(new URL(webhookPath, origin), message("friend"), milkyToken)).status).toBe(404);
      expect(gateway.calls).toHaveLength(previousCalls);
    } finally {
      if (probe.exitCode === null && probe.signalCode === null) probe.kill();
      await probe.exited;
    }
  } finally {
    gateway.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
