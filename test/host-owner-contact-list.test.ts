import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "owner-contact-fixture";
const time = 1_700_000_000;
type Reply = { action: string; params: Record<string, unknown>; echo?: string };

async function startup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const onebot = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      const http = /http:\/\/127\.0\.0\.1:\d+\/status/u.exec(output)?.[0];
      if (http && onebot) return { onebot, milky: new URL("/milky", http) };
      const chunk = await reader.read();
      if (chunk.done) throw new Error(output);
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

type Status = "ok" | "failed";
type Respond = (data: unknown, status?: Status) => void;
type Call = Reply & { respond: Respond };

function queue() {
  const calls: Call[] = [];
  let ready = Promise.withResolvers<void>();
  return {
    calls,
    add(call: Call) { calls.push(call); ready.resolve(); },
    async next(action: string) {
      const timeout = Promise.withResolvers<never>();
      const timer = setTimeout(() => timeout.reject(new Error(`未收到 ${action}`)), 2_000);
      try {
        if (!calls.length) await Promise.race([ready.promise, timeout.promise]);
        const call = calls.shift()!;
        if (!calls.length) ready = Promise.withResolvers();
        expect(call.action).toBe(action);
        return call;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

test("真实宿主从已绑定主人私聊接两协议联系人，分页、空列表和回执不泄漏", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-contact-host-"));
  const milky = queue();
  const onebot = queue();
  const sockets: WebSocket[] = [];
  const gateway = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const action = new URL(request.url).pathname.split("/").at(-1)!;
      if (action === "get_login_info") return Response.json({ status: "ok", retcode: 0, data: { uin: 100 } });
      const params = await request.json() as Reply["params"];
      const response = Promise.withResolvers<Response>();
      milky.add({ action, params, respond(data, status = "ok") {
        response.resolve(Response.json({ status, retcode: status === "ok" ? 0 : 1200, data }));
      } });
      return response.promise;
    },
  });
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "other.yaml"), 'master: ["99:42", "100:43"]\ndisablePrivate: true\n');
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${gateway.port}`, "connection: webhook", `access_token: ${token}`, "",
    ].join("\n"));
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    try {
      const endpoints = await startup(host.stdout);
      const socketType = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
      const ws = new socketType(endpoints.onebot, { headers: {
        Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99",
      } });
      sockets.push(ws);
      const opened = Promise.withResolvers<void>();
      ws.addEventListener("open", () => opened.resolve(), { once: true });
      ws.addEventListener("error", () => opened.reject(new Error("OneBot 网关未连接")), { once: true });
      ws.addEventListener("message", ({ data }) => {
        const call = JSON.parse(data) as Reply;
        onebot.add({ ...call, respond(data, status = "ok") {
          ws.send(JSON.stringify({ echo: call.echo, status, retcode: status === "ok" ? 0 : 1200, data }));
        } });
      });
      await opened.promise;
      function webhook(event: object) {
        return fetch(endpoints.milky, { method: "POST", headers: {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        }, body: JSON.stringify(event), signal: AbortSignal.timeout(2_000) });
      }
      for (let attempts = 0; ; attempts++) {
        const result = await webhook({ event_type: "fixture", self_id: 100, time, data: {} });
        if (result.status === 200) break;
        if (result.status !== 503 || attempts >= 25) throw Error("Milky 网关未连接");
        await Bun.sleep(20);
      }
      let sequence = 0;
      function sendOneBot(message: string, fields: object = {}) {
        ws.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend", message_id: ++sequence,
          self_id: 99, user_id: 42, time, message, ...fields }));
      }
      async function sendMilky(text: string, fields: object = {}, self_id = 100) {
        return webhook({ event_type: "message_receive", self_id, time, data: {
          message_scene: "friend", sender_id: 43, peer_id: 43, time, message_seq: ++sequence,
          segments: [{ type: "text", data: { text } }], ...fields,
        } });
      }

      sendOneBot("#好友列表 3", { user_id: 43 });
      sendOneBot("#好友列表 4", { message_type: "group", group_id: 77 });
      sendOneBot("#好友列表 5", { sub_type: "group" });
      sendOneBot("#好友列表 6", { self_id: 100, user_id: 43 });
      sendOneBot("#好友列表 7", { sender: { user_id: 44 } });
      sendOneBot("#好友列表 8", { group_id: 77 });
      await sendMilky("#群列表 3", { sender_id: 42, peer_id: 42 });
      await sendMilky("#群列表 4", { message_scene: "group", peer_id: 77 });
      await sendMilky("#群列表 5", { peer_id: 42 });
      await sendMilky("#群列表 6", {}, 99);
      await Bun.sleep(100);
      const blocked = await onebot.next("send_msg");
      expect(blocked.params).toMatchObject({ user_id: 43, message: expect.stringContaining("私聊功能已禁用") });
      const milkyBlocked = await milky.next("send_private_message");
      expect(milkyBlocked.params).toMatchObject({ user_id: 42,
        message: [{ type: "text", data: { text: expect.stringContaining("私聊功能已禁用") } }],
      });
      milkyBlocked.respond({ message_seq: 200 });
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);

      sendOneBot("#获取群列表 2");
      (await onebot.next("get_group_list")).respond(Array.from({ length: 43 }, (_, i) => ({
        group_id: 700 + i, group_name: i === 41 ? "伪造\n名单" : `群名${i + 1}`,
      })));
      const ob = await onebot.next("send_private_forward_msg");
      expect(ob.params).toMatchObject({ user_id: 42, messages: [
        { type: "node", data: { content: [{ type: "text", data: { text: "群列表如下，共 43 条（第 2/2 页）" } }] } },
        { type: "node", data: { content: [{ type: "text", data: { text: "41、群名41(740)\n42、未知名称(741)\n43、群名43(742)" } }] } },
      ] });
      ob.respond({ message_id: -77 });

      sendOneBot("#好友列表");
      (await onebot.next("get_friend_list")).respond([]);
      const empty = await onebot.next("send_msg");
      expect(empty.params).toMatchObject({ user_id: 42, message: "当前账号没有好友。" });
      empty.respond({ message_id: 19 });

      sendOneBot("#群列表");
      (await onebot.next("get_group_list")).respond({}, "failed");
      const missing = await onebot.next("send_msg");
      expect(missing.params).toMatchObject({ user_id: 42, message: "群列表读取失败，请稍后再试。" });
      missing.respond({ message_id: 20 });

      sendOneBot("#获取好友列表");
      (await onebot.next("get_friend_list")).respond([{ user_id: "901", nickname: "好友乙" }]);
      const unknownOb = await onebot.next("send_private_forward_msg");
      expect(unknownOb.params).toMatchObject({ user_id: 42, messages: [
        { type: "node" },
        { type: "node", data: { content: [{ data: { text: "1、好友乙(901)" } }] } },
      ] });
      unknownOb.respond({});
      const unknownObReply = await onebot.next("send_msg");
      expect(unknownObReply.params).toMatchObject({ user_id: 42, message: "好友列表发送结果未确认，请先检查私聊。" });
      unknownObReply.respond({ message_id: 21 });

      sendOneBot("#好友列表 1");
      (await onebot.next("get_friend_list")).respond([{ user_id: 902, nickname: "拒绝样本好友" }]);
      (await onebot.next("send_private_forward_msg")).respond({}, "failed");
      const refusedOb = await onebot.next("send_msg");
      expect(refusedOb.params).toMatchObject({ user_id: 42, message: "好友列表未能发送，请稍后再试。" });
      refusedOb.respond({ message_id: 22 });

      await sendMilky("#获取好友列表");
      const friends = await milky.next("get_friend_list");
      expect(friends.params).toEqual({ no_cache: true });
      friends.respond({ friends: [{ user_id: 910, nickname: "好友甲" }] });
      const forward = await milky.next("send_private_message");
      expect(forward.params).toEqual({ user_id: 43, message: [{ type: "forward", data: { messages: [
        { user_id: 100, sender_name: "Lotus-Yunzai", segments: [{ type: "text", data: { text: "好友列表如下，共 1 条（第 1/1 页）" } }] },
        { user_id: 100, sender_name: "Lotus-Yunzai", segments: [{ type: "text", data: { text: "1、好友甲(910)" } }] },
      ] } }] });
      forward.respond({});
      const unknown = await milky.next("send_private_message");
      expect(unknown.params).toEqual({ user_id: 43, message: [{ type: "text", data: { text: "好友列表发送结果未确认，请先检查私聊。" } }] });
      unknown.respond({ message_seq: 201 });

      await sendMilky("#群列表 0");
      const invalid = await milky.next("send_private_message");
      expect(invalid.params).toMatchObject({ user_id: 43, message: [{ type: "text", data: { text: "用法 #群列表 [页码]" } }] });
      invalid.respond({ message_seq: 202 });

      await sendMilky("#群列表 2");
      (await milky.next("get_group_list")).respond({ groups: [{ group_id: 900, group_name: "群甲" }] });
      const outside = await milky.next("send_private_message");
      expect(outside.params).toMatchObject({ user_id: 43, message: [{ type: "text", data: { text: "群列表只有 1 页，请输入 1-1。" } }] });
      outside.respond({ message_seq: 203 });

      await sendMilky("#群列表");
      (await milky.next("get_group_list")).respond({ groups: [{ group_id: 999, group_name: "拒绝样本群" }] });
      (await milky.next("send_private_message")).respond({}, "failed");
      const rejected = await milky.next("send_private_message");
      expect(rejected.params).toEqual({ user_id: 43, message: [{ type: "text", data: { text: "群列表未能发送，请稍后再试。" } }] });
      rejected.respond({ message_seq: 204 });

      await sendMilky("#获取群列表 2");
      (await milky.next("get_group_list")).respond({ groups: Array.from({ length: 41 }, (_, i) => ({
        group_id: 1_100 + i, group_name: `Milky群${i + 1}`,
      })) });
      const second = await milky.next("send_private_message");
      expect(second.params).toMatchObject({ user_id: 43, message: [{ type: "forward", data: { messages: [
        { segments: [{ data: { text: "群列表如下，共 41 条（第 2/2 页）" } }] },
        { segments: [{ data: { text: "41、Milky群41(1140)" } }] },
      ] } }] });
      second.respond({ message_seq: 205 });

      await sendMilky("#好友列表");
      (await milky.next("get_friend_list")).respond({ friends: [] });
      const emptyMilky = await milky.next("send_private_message");
      expect(emptyMilky.params).toMatchObject({ user_id: 43, message: [{ data: { text: "当前账号没有好友。" } }] });
      emptyMilky.respond({ message_seq: 206 });

      await sendMilky("#好友列表 1");
      (await milky.next("get_friend_list")).respond({ friends: [null] });
      const malformedMilky = await milky.next("send_private_message");
      expect(malformedMilky.params).toMatchObject({ user_id: 43, message: [{ data: { text: "好友列表读取失败，请稍后再试。" } }] });
      malformedMilky.respond({ message_seq: 207 });

      await Bun.sleep(100);
      expect(onebot.calls).toEqual([]);
      expect(milky.calls).toEqual([]);
    } finally {
      for (const socket of sockets) socket.close();
      host.kill();
      await host.exited;
    }
  } finally {
    gateway.stop(true);
    await rm(root, { force: true, recursive: true });
  }
}, 12_000);
