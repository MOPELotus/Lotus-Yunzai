import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const recallCommand = "#撤回夹具";
const groupReceiptId = 5001;
const privateReceiptId = 5002;
const quotedMessageId = 88;
const temporaryImage = "https://images.example.invalid/milky/fixture.png?nonce=sample";
const fixturePng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

interface GatewayCall {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
  receivedAt: number;
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
  const likeArrived = Promise.withResolvers<GatewayCall>();
  const releaseLike = Promise.withResolvers<void>();
  const releaseRecallSend = Promise.withResolvers<void>();
  const recalls = {
    group: Promise.withResolvers<GatewayCall>(),
    private: Promise.withResolvers<GatewayCall>(),
  };
  let loginAttempts = 0;
  let friendQueries = 0;
  const replies = {
    private: Promise.withResolvers<GatewayCall>(),
    group: Promise.withResolvers<GatewayCall>(),
    nonFriend: Promise.withResolvers<GatewayCall>(),
    duplicateLike: Promise.withResolvers<GatewayCall>(),
    liked: Promise.withResolvers<GatewayCall>(),
    timedGroup: Promise.withResolvers<GatewayCall>(),
    timedPrivate: Promise.withResolvers<GatewayCall>(),
  };
  const privateReplies = [replies.private, replies.timedPrivate];
  const groupReplies = [replies.group, replies.nonFriend, replies.duplicateLike, replies.liked, replies.timedGroup];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const call: GatewayCall = {
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.json(),
        receivedAt: performance.now(),
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
        case `${prefix}/api/send_private_message`: {
          const next = privateReplies.shift();
          next?.resolve(call);
          if (next === replies.timedPrivate) {
            return Response.json({ status: "ok", retcode: 0, data: { message_seq: privateReceiptId, time: timestamp } });
          }
          break;
        }
        case `${prefix}/api/get_friend_info`: {
          const user_id = ++friendQueries === 1 ? senderId + 1 : senderId;
          return Response.json({ status: "ok", retcode: 0, data: { friend: { user_id, nickname: "好友夹具" } } });
        }
        case `${prefix}/api/send_profile_like`:
          likeArrived.resolve(call);
          await releaseLike.promise;
          return Response.json({ status: "ok", retcode: 0, data: {} });
        case `${prefix}/api/send_group_message`: {
          const next = groupReplies.shift();
          next?.resolve(call);
          if (next === replies.timedGroup) {
            await releaseRecallSend.promise;
            return Response.json({ status: "ok", retcode: 0, data: { message_seq: groupReceiptId, time: timestamp } });
          }
          break;
        }
        case `${prefix}/api/recall_group_message`:
          recalls.group.resolve(call);
          return Response.json({ status: "failed", retcode: -404, message: "撤回被拒绝" });
        case `${prefix}/api/recall_private_message`:
          recalls.private.resolve(call);
          return Response.json({ status: "ok", retcode: 0, data: {} });
        default:
          return new Response(null, { status: 404 });
      }
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: 100, time: timestamp } });
    },
  });
  return {
    server, calls, loginArrived, releaseLogin, reloginArrived, releaseRelogin, likeArrived, releaseLike,
    replies, releaseRecallSend, recalls,
  };
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

function message(scene: "friend" | "group", selfId = botId, text = command, sequence = scene === "friend" ? 11 : 12) {
  return {
    time: timestamp,
    self_id: selfId,
    event_type: "message_receive",
    data: {
      message_scene: scene,
      peer_id: scene === "friend" ? senderId : groupId,
      message_seq: sequence,
      sender_id: senderId,
      time: timestamp,
      segments: [
        { type: "text", data: { text } },
        ...(text === recallCommand ? [{
          type: "reply",
          data: { message_seq: quotedMessageId, sender_id: senderId, time: timestamp, segments: [] },
        }] : []),
        ...(scene === "group" && text === command ? [{
          type: "image",
          data: { resource_id: "fixture-image", temp_url: temporaryImage, width: 1, height: 1, summary: "", sub_type: "normal" },
        }] : []),
      ],
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

test("Milky Webhook 独立鉴权并按已绑定账号处理消息、图片、点赞和定时撤回", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-webhook-"));
  const gateway = mockGateway();
  try {
    await copyHost(root);
    await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins", "group"), {
      recursive: true, filter: (path) => !path.endsWith("/.git"),
    });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "group.yaml"), [
      "strangeThumbUp: false", "count: 3", "noFriendMsg: 仅好友可用", 'successMsg: "确认 {{thumbUpNum}}"',
    ].join("\n") + "\n");
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
          super({ event: "message", rule: [
            { reg: "^${command}$", fnc: "echo" },
            { reg: "^${recallCommand}$", fnc: "recall" },
          ] });
        }
        recall(e) {
          return e.reply("撤回夹具回复", false, { recallMsg: 0.05 });
        }
        echo(e) {
          if (!e.isGroup) return e.reply("好友 " + e.user_id + " 机器人 " + e.self_id);
          const fixture = new Uint8Array(Buffer.from(${JSON.stringify(fixturePng)}, "base64"));
          return e.reply([
            "群 " + e.group_id + " 成员 " + e.user_id + " 机器人 " + e.self_id,
            ...(e.img ?? []).map((url) => segment.image(url)),
            segment.image(fixture),
          ]);
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
        group_id: groupId,
        message: [
          { type: "text", data: { text: `群 ${groupId} 成员 ${senderId} 机器人 ${botId}` } },
          { type: "image", data: { uri: temporaryImage, sub_type: "normal" } },
          { type: "image", data: { uri: `base64://${fixturePng}`, sub_type: "normal" } },
        ],
      });
      expect(gateway.calls.map(({ path }) => path)).toEqual([
        loginPath, loginPath, `${prefix}/api/send_private_message`, `${prefix}/api/send_group_message`,
      ]);

      const beforeLikes = gateway.calls.length;
      const friendPath = `${prefix}/api/get_friend_info`;
      const likePath = `${prefix}/api/send_profile_like`;
      const groupPath = `${prefix}/api/send_group_message`;
      expect((await webhook(endpoint, message("group", botId, "#赞我", 20), milkyToken)).status).toBe(200);
      const deniedLike = await deadline(gateway.replies.nonFriend.promise, "Milky 未回报非好友点赞拒绝。");
      expect(deniedLike.body).toEqual({ group_id: groupId, message: [{ type: "text", data: { text: "仅好友可用" } }] });
      expect(gateway.calls.slice(beforeLikes).map(({ path }) => path)).toEqual([friendPath, groupPath]);

      expect((await webhook(endpoint, message("group", botId, "#赞我", 21), milkyToken)).status).toBe(200);
      const like = await deadline(gateway.likeArrived.promise, "Milky 未收到群模块点赞调用。");
      expect(like.body).toEqual({ user_id: senderId, count: 3 });
      expect((await webhook(endpoint, message("group", botId, "#点赞", 22), milkyToken)).status).toBe(200);
      const duplicateLike = await deadline(gateway.replies.duplicateLike.promise, "Milky 未回报正在处理点赞。");
      expect(duplicateLike.body).toEqual({
        group_id: groupId, message: [{ type: "text", data: { text: "正在处理你的点赞请求。" } }],
      });
      gateway.releaseLike.resolve();
      const confirmedLike = await deadline(gateway.replies.liked.promise, "Milky 未回报点赞成功。");
      expect(confirmedLike.body).toEqual({ group_id: groupId, message: [{ type: "text", data: { text: "确认 3" } }] });
      const likeCalls = gateway.calls.slice(beforeLikes);
      expect(likeCalls.map(({ path }) => path)).toEqual([friendPath, groupPath, friendPath, likePath, groupPath, groupPath]);
      expect(likeCalls.filter(({ path }) => path === friendPath).map(({ body }) => body)).toEqual([
        { user_id: senderId, no_cache: true }, { user_id: senderId, no_cache: true },
      ]);

      const beforeRecalls = gateway.calls.length;
      const replyText = [{ type: "text", data: { text: "撤回夹具回复" } }];
      expect((await webhook(endpoint, message("group", botId, recallCommand, 90), milkyToken)).status).toBe(200);
      const groupSend = await deadline(gateway.replies.timedGroup.promise, "Milky 未发送预定撤回的群回复。");
      expect(groupSend.body).toEqual({ group_id: groupId, message: replyText });
      await Bun.sleep(100);
      expect(gateway.calls.slice(beforeRecalls).map(({ path }) => path)).toEqual([groupPath]);
      const startedRecallTimer = performance.now();
      gateway.releaseRecallSend.resolve();
      const groupRecall = await deadline(gateway.recalls.group.promise, "Milky 未请求撤回确认送达的群回复。");
      expect(groupRecall.body).toEqual({ group_id: groupId, message_seq: groupReceiptId });
      expect(groupRecall.receivedAt - startedRecallTimer).toBeGreaterThanOrEqual(45);

      expect((await webhook(endpoint, message("friend", botId, recallCommand, 91), milkyToken)).status).toBe(200);
      const privateSend = await deadline(gateway.replies.timedPrivate.promise, "Milky 未发送预定撤回的好友回复。");
      expect(privateSend.body).toEqual({ user_id: senderId, message: replyText });
      const privateRecall = await deadline(gateway.recalls.private.promise, "Milky 未请求撤回确认送达的好友回复。");
      expect(privateRecall.body).toEqual({ user_id: senderId, message_seq: privateReceiptId });
      await Bun.sleep(150);
      expect(gateway.calls.slice(beforeRecalls).map(({ path }) => path)).toEqual([
        groupPath, `${prefix}/api/recall_group_message`, `${prefix}/api/send_private_message`, `${prefix}/api/recall_private_message`,
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
      gateway.releaseLike.resolve();
      gateway.releaseRecallSend.resolve();
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
