import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const token = "milky-notice-fixture";
const botId = 99;
const memberId = 42;
const groupId = 77;
const timestamp = 1_700_000_000;
const groupName = "模拟讨论群";

interface Call {
  action: string;
  body: unknown;
}

function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function mockGateway() {
  let groupReceipt: "confirmed" | "rejected" | "unknown" = "confirmed";
  let ready = Promise.withResolvers<void>();
  const calls: Call[] = [];
  let handled = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response(null, { status: 401 });
      }
      const action = new URL(request.url).pathname.slice("/api/".length);
      const body = await request.json();
      calls.push({ action, body });
      ready.resolve();

      switch (action) {
        case "get_login_info":
          return Response.json({ status: "ok", retcode: 0, data: { uin: botId, nickname: "测试机器人" } });
        case "get_group_info":
          return Response.json({ status: "ok", retcode: 0, data: { group: { group_id: groupId, group_name: groupName } } });
        case "send_group_message": {
          const receipt = groupReceipt;
          groupReceipt = "confirmed";
          if (receipt === "unknown") return new Response(null, { status: 503 });
          if (receipt === "rejected") return Response.json({ status: "failed", retcode: -404, message: "头像不可用" });
          break;
        }
        case "send_private_message":
          break;
        default:
          return new Response(null, { status: 404 });
      }
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: 100 + calls.length, time: timestamp } });
    },
  });
  return {
    server, calls,
    groupReply(value: typeof groupReceipt) { groupReceipt = value; },
    async next(action: string) {
      if (handled === calls.length) await deadline(ready.promise, `Milky 未收到 ${action}。`);
      const call = calls[handled++]!;
      if (handled === calls.length) ready = Promise.withResolvers<void>();
      expect(call.action).toBe(action);
      return call.body;
    },
  };
}

async function startup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const part = await reader.read();
      if (part.done) throw new Error("Milky 通知测试宿主未启动。\n" + output);
      output += decoder.decode(part.value, { stream: true });
    }
    const origin = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
    if (!origin) throw new Error("Milky 通知测试宿主未输出 HTTP 监听地址。");
    return new URL("/milky", origin);
  } finally {
    reader.releaseLock();
  }
}

function webhook(endpoint: URL, eventType: string, data: object, selfId = botId, authenticated = true) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ time: timestamp, self_id: selfId, event_type: eventType, data }),
    signal: AbortSignal.timeout(2_000),
  });
}

async function waitForBind(endpoint: URL) {
  const stopAt = performance.now() + 2_000;
  for (;;) {
    const response = await webhook(endpoint, "fixture_unsupported", {});
    if (response.status !== 503 || performance.now() >= stopAt) {
      expect(response.status).toBe(200);
      return;
    }
    await Bun.sleep(25);
  }
}

function text(text: string) {
  return { type: "text", data: { text } };
}

function avatar(userId: number) {
  return { type: "image", data: { uri: `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=100`, sub_type: "normal" } };
}

function nudge(sent: boolean, received: boolean, userId = memberId) {
  return {
    user_id: userId, is_self_send: sent, is_self_receive: received,
    display_action: "戳了戳", display_suffix: "", display_action_img_url: "",
  };
}

test("Milky Webhook 分发真实群进退与好友戳一戳通知", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-notice-"));
  const mock = mockGateway();
  try {
    await copyHost(root);
    await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins", "group"), {
      recursive: true, filter: (path) => !path.endsWith("/.git"),
    });
    const meme = join(root, "plugins", "meme");
    await mkdir(meme);
    await writeFile(join(meme, "package.json"), JSON.stringify({
      name: "@lotus-yunzai/meme", lotusYunzai: { entry: "./lotus.js" },
    }));
    await writeFile(join(meme, "lotus.js"), `
      export function createModule() {
        return { commands: {}, async handlePoke(event) {
          if (event.backend !== "milky" || !event.allowed() || event.signal.aborted) return;
          if (await event.reply("原生群戳 " + event.actorId + " " + event.targetId)) {
            await Bun.write(new URL("./confirmed.txt", import.meta.url), "已确认");
          }
        } };
      }
    `);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.port}`,
      "connection: webhook", `access_token: ${token}`,
    ].join("\n") + "\n");
    await writeFile(join(root, "plugins", "milky-nudge-fixture.js"), `
      export const apps = {
        privatePoke: class extends plugin {
          constructor() { super({ event: "notice.friend.poke" }); }
          async accept(e) {
            await e.reply("好友戳一戳 " + e.user_id + " " + e.operator_id + " " + e.target_id);
            return "return";
          }
        },
        groupPoke: class extends plugin {
          constructor() { super({ event: "notice.group.poke" }); }
          async accept(e) {
            if (e.user_id !== ${memberId}) return false;
            await e.reply("群戳一戳 " + e.user_id + " " + e.operator_id + " " + e.target_id);
            return "return";
          }
        }
      }
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0" },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const endpoint = await deadline(startup(host.stdout), "Milky 通知测试宿主启动超时。");
      expect(await mock.next("get_login_info")).toEqual({});
      await waitForBind(endpoint);

      expect((await webhook(endpoint, "friend_nudge", nudge(false, true), botId, false)).status).toBe(401);
      const joinEvent = { group_id: groupId, user_id: memberId, invitor_id: 21 };
      expect((await webhook(endpoint, "group_member_increase", joinEvent, botId + 1)).status).toBe(403);
      expect((await webhook(endpoint, "group_member_increase", { ...joinEvent, user_id: botId })).status).toBe(200);
      expect((await webhook(endpoint, "friend_nudge", nudge(true, false))).status).toBe(200);
      expect((await webhook(endpoint, "friend_nudge", nudge(true, true, botId))).status).toBe(200);
      expect((await webhook(endpoint, "friend_nudge", nudge(false, true, botId))).status).toBe(200);
      expect((await webhook(endpoint, "group_member_increase", joinEvent)).status).toBe(200);
      expect(await mock.next("get_group_info")).toEqual({ group_id: groupId, no_cache: true });
      expect(await mock.next("send_group_message")).toEqual({
        group_id: groupId,
        message: [
          avatar(memberId), text("\n"), text(`🌸 欢迎来到「${groupName}」\n\n`),
          { type: "mention", data: { user_id: memberId } }, text(" 欢迎加入～\n先看看群公告，有问题随时交流。"),
        ],
      });

      mock.groupReply("rejected");
      const removed = text(`📋 成员变动\n\nQQ ${memberId} 已被移出本群。`);
      expect((await webhook(endpoint, "group_member_decrease", { group_id: groupId, user_id: memberId, operator_id: 21 })).status).toBe(200);
      expect(await mock.next("send_group_message")).toEqual({ group_id: groupId, message: [avatar(memberId), text("\n"), removed] });
      expect(await mock.next("send_group_message")).toEqual({ group_id: groupId, message: [removed] });

      mock.groupReply("unknown");
      const otherMember = memberId + 1;
      expect((await webhook(endpoint, "group_member_decrease", { group_id: groupId, user_id: otherMember })).status).toBe(200);
      expect(await mock.next("send_group_message")).toEqual({
        group_id: groupId,
        message: [avatar(otherMember), text("\n"), text(`🍃 成员离开\n\nQQ ${otherMember} 已退出本群。\n有缘再见，祝一切顺利。`)],
      });

      expect((await webhook(endpoint, "friend_nudge", nudge(false, true))).status).toBe(200);
      expect(await mock.next("send_private_message")).toEqual({
        user_id: memberId, message: [text(`好友戳一戳 ${memberId} ${memberId} ${botId}`)],
      });
      const groupPoke = { group_id: groupId, sender_id: memberId, receiver_id: botId };
      expect((await webhook(endpoint, "group_nudge", groupPoke, botId + 1)).status).toBe(403);
      expect((await webhook(endpoint, "group_nudge", { ...groupPoke, receiver_id: "99" })).status).toBe(200);
      expect((await webhook(endpoint, "group_nudge", groupPoke)).status).toBe(200);
      expect(await mock.next("send_group_message")).toEqual({
        group_id: groupId, message: [text(`群戳一戳 ${memberId} ${memberId} ${botId}`)],
      });
      expect((await webhook(endpoint, "group_nudge", { ...groupPoke, sender_id: otherMember })).status).toBe(200);
      expect(await mock.next("send_group_message")).toEqual({
        group_id: groupId, message: [text(`原生群戳 ${otherMember} ${botId}`)],
      });
      await Bun.sleep(80);
      expect(await readFile(join(meme, "confirmed.txt"), "utf8")).toBe("已确认");
      expect(mock.calls.map(({ action }) => action)).toEqual([
        "get_login_info", "get_group_info", "send_group_message", "send_group_message", "send_group_message",
        "send_group_message", "send_private_message", "send_group_message", "send_group_message",
      ]);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
    }
    expect(await stderr).not.toContain(token);
  } finally {
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
