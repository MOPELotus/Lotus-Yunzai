import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const milkyToken = "milky-mute-fixture";
const oneBotToken = "onebot-mute-fixture";
const botId = 99;
const actor = 42;
const operator = 51;
const mutedGroup = 77;
const otherGroup = 78;
const time = 1_700_000_000;
const statusCommand = "#状态";
const statusReply = /^Lotus-Yunzai 正在运行/u;

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function mockGateway() {
  const calls: { action: string; body: unknown }[] = [];
  let ready = Promise.withResolvers<void>();
  let handled = 0;
  let member: object = {};
  function accepted(data: object) {
    return Response.json({ status: "ok", retcode: 0, data });
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${milkyToken}`) {
        return new Response(null, { status: 401 });
      }
      const action = new URL(request.url).pathname.slice("/api/".length);
      calls.push({ action, body: await request.json() });
      ready.resolve();
      switch (action) {
        case "get_login_info": return accepted({ uin: botId, nickname: "禁言夹具" });
        case "get_group_member_info": return accepted({ member });
        case "send_group_message": return accepted({ message_seq: 100 + calls.length, time });
        default: return new Response(null, { status: 404 });
      }
    },
  });
  async function next(action: string, body: unknown) {
    if (handled === calls.length) await deadline(ready.promise, `未收到 Milky ${action}。`);
    const call = calls[handled++]!;
    if (handled === calls.length) ready = Promise.withResolvers<void>();
    expect(call).toEqual({ action, body });
  }
  return {
    server, next,
    setMember(group_id: number, user_id: number, role: string) { member = { group_id, user_id, role }; },
    expectRoleLookup: () => next("get_group_member_info", { group_id: mutedGroup, user_id: botId, no_cache: true }),
    expectStatus: (groupId: number) => next("send_group_message", {
      group_id: groupId, message: [{ type: "text", data: { text: expect.stringMatching(statusReply) } }],
    }),
    expectDrained() { expect(calls).toHaveLength(handled); },
  };
}

async function startup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Milky 禁言测试宿主未启动。\n" + output);
      output += decoder.decode(chunk.value, { stream: true });
    }
    const origin = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
    const ws = /OneBot 11 正在监听 (ws:\/\/127\.0\.0\.1:\d+\/OneBotv11)/u.exec(output)?.[1];
    if (!origin || !ws) throw new Error("Milky 禁言测试宿主未输出 HTTP 或 OneBot 监听地址。");
    return { webhookUrl: new URL("/milky", origin), oneBotUrl: ws };
  } finally {
    reader.releaseLock();
  }
}

function webhook(url: URL, type: string, data: object, selfId = botId) {
  const eventTime = Math.floor(Date.now() / 1_000);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${milkyToken}` },
    body: JSON.stringify({ time: eventTime, self_id: selfId, event_type: type, data }),
    signal: AbortSignal.timeout(2_000),
  });
}

async function waitForBind(url: URL) {
  const stopAt = performance.now() + 2_000;
  for (;;) {
    const response = await webhook(url, "fixture_unsupported", {});
    if (response.status !== 503 || performance.now() >= stopAt) {
      expect(response.status).toBe(200);
      return;
    }
    await Bun.sleep(25);
  }
}

async function checkSameAccountOneBot(url: string) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(url, {
    headers: { Authorization: `Bearer ${oneBotToken}`, "X-Client-Role": "Universal", "X-Self-ID": String(botId) },
  });
  try {
    const reply = await deadline(new Promise<unknown>((resolve, reject) => {
      socket.addEventListener("message", ({ data }) => resolve(JSON.parse(data)), { once: true });
      socket.addEventListener("error", () => reject(new Error("OneBot 禁言夹具连接失败。")), { once: true });
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        post_type: "message", message_type: "group", sub_type: "normal", self_id: botId,
        user_id: actor, group_id: mutedGroup, message_id: 1, message: statusCommand,
      })), { once: true });
    }), "同 QQ 的 OneBot 未回复群状态。");
    expect(reply).toMatchObject({
      action: "send_msg", params: { group_id: mutedGroup, message: expect.stringMatching(statusReply) },
    });
  } finally {
    socket.close();
  }
}

test("Milky 群禁言按机器人和会话生效，全员禁言以实时本人角色为准", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-mute-"));
  const mock = mockGateway();
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.url.port}`,
      "connection: webhook", `access_token: ${milkyToken}`,
    ].join("\n") + "\n");
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: oneBotToken },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const { webhookUrl, oneBotUrl } = await deadline(startup(host.stdout), "Milky 禁言测试宿主启动超时。");
      await mock.next("get_login_info", {});
      await waitForBind(webhookUrl);
      let seq = 0;
      async function command(groupId = mutedGroup) {
        expect((await webhook(webhookUrl, "message_receive", {
          time, message_scene: "group", peer_id: groupId, sender_id: actor, message_seq: ++seq,
          group_member: { group_id: groupId, user_id: actor, role: "owner" },
          segments: [{ type: "text", data: { text: statusCommand } }],
        })).status).toBe(200);
      }
      const mute = { group_id: mutedGroup, operator_id: operator, user_id: botId, duration: 60 };
      const groupChange = { group_id: mutedGroup, operator_id: operator };
      const adminChange = { ...groupChange, user_id: botId };
      async function barrier() {
        await command(otherGroup);
        await mock.expectStatus(otherGroup);
        await Bun.sleep(50);
        mock.expectDrained();
      }

      expect((await webhook(webhookUrl, "group_mute", mute, botId + 1)).status).toBe(403);
      expect((await webhook(webhookUrl, "group_mute", { ...mute, user_id: actor })).status).toBe(200);
      await command();
      await mock.expectStatus(mutedGroup);

      expect((await webhook(webhookUrl, "group_mute", mute)).status).toBe(200);
      await command();
      await barrier();
      await checkSameAccountOneBot(oneBotUrl);
      expect((await webhook(webhookUrl, "group_mute", { ...mute, duration: 0 })).status).toBe(200);
      await command();
      await mock.expectStatus(mutedGroup);

      expect((await webhook(webhookUrl, "group_whole_mute", { ...groupChange, is_mute: true })).status).toBe(200);
      mock.setMember(otherGroup, botId, "admin");
      await command();
      await mock.expectRoleLookup();
      await barrier();
      mock.setMember(mutedGroup, actor, "owner");
      await command();
      await mock.expectRoleLookup();
      await barrier();

      expect((await webhook(webhookUrl, "group_admin_change", { ...adminChange, is_set: true })).status).toBe(200);
      mock.setMember(mutedGroup, botId, "admin");
      await command();
      await mock.expectRoleLookup();
      await mock.expectStatus(mutedGroup);
      await command();
      await mock.expectStatus(mutedGroup);

      expect((await webhook(webhookUrl, "group_admin_change", { ...adminChange, is_set: false })).status).toBe(200);
      mock.setMember(mutedGroup, botId, "member");
      await command();
      await mock.expectRoleLookup();
      await barrier();

      expect((await webhook(webhookUrl, "group_whole_mute", { ...groupChange, is_mute: false })).status).toBe(200);
      await command();
      await mock.expectStatus(mutedGroup);
      mock.expectDrained();
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
    }
    expect(await stderr).not.toContain(milkyToken);
  } finally {
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
