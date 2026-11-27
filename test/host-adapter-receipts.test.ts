import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createProcessReceipts } from "../lib/process-receipts.ts";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const botId = 99;
const oneBotToken = "adapter-receipts-onebot-fixture";
const milkyToken = "adapter-receipts-milky-fixture";
const revision = "0123456789012345678901234567890123456789";
const requester = 66;
const time = 1_700_000_000;

interface OneBotFrame {
  action: string;
  echo?: string;
  params: { message: string; group_id?: number; user_id?: number };
}

function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function queue<T>(name: string) {
  const pending: T[] = [];
  let ready = Promise.withResolvers<void>();
  return {
    pending,
    push(value: T) {
      pending.push(value);
      ready.resolve();
    },
    async next() {
      if (pending.length === 0) await deadline(ready.promise, `未收到 ${name} 回执消息。`);
      const value = pending.shift()!;
      if (pending.length === 0) ready = Promise.withResolvers<void>();
      return value;
    },
  };
}

function milkyGateway() {
  const requests = queue<{ action: string; body: unknown }>("Milky");
  const upgrading = Promise.withResolvers<void>();
  const releaseUpgrade = Promise.withResolvers<void>();
  const connections = queue<Bun.ServerWebSocket>("Milky WebSocket");
  let sequence = 100;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, gateway) {
      if (request.headers.get("Authorization") !== `Bearer ${milkyToken}`) return new Response(null, { status: 401 });
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/event") {
        upgrading.resolve();
        await releaseUpgrade.promise;
        if (gateway.upgrade(request)) return;
        return new Response(null, { status: 426 });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (pathname === "/api/get_login_info") {
        return Response.json({ status: "ok", retcode: 0, data: { uin: botId, nickname: "回执夹具" } });
      }
      requests.push({ action: pathname.slice("/api/".length), body: await request.json() });
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: ++sequence, time } });
    },
    websocket: {
      open(socket) { connections.push(socket); },
      message() {},
    },
  });
  return { server, requests, upgrading, releaseUpgrade, connections };
}

async function oneBotEndpoint(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const part = await reader.read();
      if (part.done) throw new Error("回执测试宿主未启动。\n" + output);
      output += decoder.decode(part.value, { stream: true });
    }
    const url = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
    if (!url) throw new Error("回执测试宿主未输出 OneBot 监听地址。");
    return url;
  } finally {
    reader.releaseLock();
  }
}

async function oneBotGateway(url: string) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(url, { headers: {
    Authorization: `Bearer ${oneBotToken}`, "X-Client-Role": "Universal", "X-Self-ID": String(botId),
  } });
  const replies = queue<OneBotFrame>("OneBot");
  socket.addEventListener("message", ({ data }) => replies.push(JSON.parse(data)));
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
  try {
    await deadline(new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("OneBot 回执夹具连接失败。")), { once: true });
    }), "OneBot 回执夹具未连接。");
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    replies, closed,
    close() { socket.close(); },
    ack(frame: OneBotFrame) {
      expect(typeof frame.echo).toBe("string");
      socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 123 } }));
    },
    command() {
      socket.send(JSON.stringify({
        post_type: "message", message_type: "private", sub_type: "friend", self_id: botId, user_id: requester, message: "#状态",
      }));
      return replies.next();
    },
  };
}

function milkyStatus(socket: Bun.ServerWebSocket) {
  socket.send(JSON.stringify({
    self_id: botId, time, event_type: "message_receive",
    data: {
      time, message_scene: "friend", peer_id: requester, sender_id: requester, message_seq: 1,
      segments: [{ type: "text", data: { text: "#状态" } }],
    },
  }));
}

for (const withReport of [false, true]) test(`同一 QQ 的 OneBot 和 Milky 独立领取三类启动回执，更新日志 ${withReport}`, async () => {
  const reports = [{ name: "Lotus-Yunzai", date: "2026-11-27 22:00:00", lines: ["[2026-11-27 22:00:00] fixture update"] }];
  const root = await mkdtemp(join(tmpdir(), "lotus-adapter-receipts-"));
  const milky = milkyGateway();
  const oneBotClients: Awaited<ReturnType<typeof oneBotGateway>>[] = [];
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${milky.server.port}`,
      `access_token: ${milkyToken}`, "ws:", "  reconnect_interval: 0.05",
    ].join("\n") + "\n");
    disableMemberPrewarm(root);
    const receipts = createProcessReceipts(pathToFileURL(root + "/"));
    const at = Date.now() - 1_000;
    await Promise.all([
      receipts.save({ kind: "restart", at, target: { type: "group", botId, id: 701 } }),
      receipts.save({ kind: "update", result: "updated", revision, at, ...(withReport ? { reports } : {}), target: { type: "private", botId, id: 741 } }),
      receipts.save({ kind: "install", name: "onebot-fixture", result: "rolled-back", at, target: { type: "group", botId, id: 702 } }),
      receipts.save({ kind: "restart", at, target: { type: "private", botId, id: 742, adapter: "milky" } }),
      receipts.save({
        kind: "update", ...(withReport ? { result: "updated" as const, revision, reports } : { result: "rolled-back" as const }), at, target: { type: "group", botId, id: 703, adapter: "milky" },
      }),
      receipts.save({
        kind: "install", name: "milky-fixture", result: "installed", revision, at,
        target: { type: "private", botId, id: 743, adapter: "milky" },
      }),
    ]);

    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: oneBotToken },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const url = await deadline(oneBotEndpoint(host.stdout), "回执测试宿主启动超时。");
      await deadline(milky.upgrading.promise, "Milky 登录后未请求事件连接。");
      const firstOneBot = await oneBotGateway(url);
      oneBotClients.push(firstOneBot);
      const oneBotReceipts: OneBotFrame[] = [];
      for (let count = 0; count < (withReport ? 4 : 3); count++) {
        const frame = await firstOneBot.replies.next();
        oneBotReceipts.push(frame);
        firstOneBot.ack(frame);
      }
      expect(oneBotReceipts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: "send_msg", params: expect.objectContaining({
            message_type: "group", group_id: 701, message: expect.stringMatching(/^重启成功，用时/u),
          }),
        }),
        expect.objectContaining({
          action: "send_msg", params: expect.objectContaining({
            message_type: "private", user_id: 741, message: withReport ? "Lotus-Yunzai 更新完成\n更新时间：2026-11-27 22:00:00" : "更新成功，提交 012345678901",
          }),
        }),
        expect.objectContaining({
          action: "send_msg", params: expect.objectContaining({
            message_type: "group", group_id: 702, message: "安装 onebot-fixture 失败，已恢复旧版本。",
          }),
        }),
      ]));
      if (withReport) {
        const forward = oneBotReceipts.find(frame => frame.action === "send_private_forward_msg");
        expect(forward).toMatchObject({ params: { user_id: 741 } });
        expect(JSON.stringify(forward)).toContain("fixture update");
        expect(JSON.stringify(forward)).toContain("更新日志");
      }
      expect(milky.requests.pending).toEqual([]);

      milky.releaseUpgrade.resolve();
      const firstMilky = await milky.connections.next();
      const text = (value: unknown) => [{ type: "text", data: { text: value } }];
      const milkyReceipts = [
        await milky.requests.next(), await milky.requests.next(), await milky.requests.next(),
      ];
      if (withReport) milkyReceipts.push(await milky.requests.next());
      expect(milkyReceipts).toEqual(expect.arrayContaining([
        { action: "send_private_message", body: { user_id: 742, message: text(expect.stringMatching(/^重启成功，用时/u)) } },
        { action: "send_group_message", body: { group_id: 703, message: text(withReport ? "Lotus-Yunzai 更新完成\n更新时间：2026-11-27 22:00:00" : "更新失败，已恢复旧版本。") } },
        { action: "send_private_message", body: { user_id: 743, message: text("安装 milky-fixture 成功，提交 012345678901。") } },
      ]));

      if (withReport) {
        const forward = milkyReceipts.find(frame => JSON.stringify(frame.body).includes('"type":"forward"'));
        expect(JSON.stringify(forward)).toContain("fixture update");
        expect(JSON.stringify(forward)).toContain("更新日志");
      }
      firstOneBot.close();
      await deadline(firstOneBot.closed, "OneBot 原回执连接未关闭。");
      firstMilky.close(1012, "fixture reconnect");
      const secondOneBot = await oneBotGateway(url);
      oneBotClients.push(secondOneBot);
      const secondMilky = await milky.connections.next();
      expect(await secondOneBot.command()).toMatchObject({
        action: "send_msg", params: { user_id: requester, message: expect.stringContaining("Lotus-Yunzai 正在运行") },
      });
      milkyStatus(secondMilky);
      expect(await milky.requests.next()).toEqual({
        action: "send_private_message",
        body: { user_id: requester, message: text(expect.stringContaining("Lotus-Yunzai 正在运行")) },
      });
      await Bun.sleep(80);
      expect(firstOneBot.replies.pending).toEqual([]);
      expect(secondOneBot.replies.pending).toEqual([]);
      expect(milky.requests.pending).toEqual([]);
    } finally {
      milky.releaseUpgrade.resolve();
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
    }
    expect(await stderr).not.toContain("未确认进程操作回执");
  } finally {
    oneBotClients.forEach((client) => client.close());
    milky.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
