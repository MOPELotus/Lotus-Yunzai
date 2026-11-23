import { expect, test } from "bun:test";
import { milkyMessage } from "../lib/adapters/milky-message.ts";
import { openMilkySession } from "../lib/adapters/milky-session.ts";
import { OneBotGroups } from "../lib/adapters/onebot-groups.ts";
import { startOneBot } from "../lib/adapters/onebot.ts";
import type { MessageEvent, RecallOwnReply } from "../lib/messages.ts";

test("OneBot 只为原连接确认送达的机器人回复签发一次性撤回句柄", async () => {
  const event = Promise.withResolvers<MessageEvent>();
  const token = "own-reply-recall-fixture";
  const server = startOneBot(async message => { if (message.post_type === "message") event.resolve(message); }, {
    hostname: "127.0.0.1", port: 0, groups: new OneBotGroups(),
    auth: new Headers({ Authorization: `Bearer ${token}` }), isMaster: () => false, masterIds: () => [],
  });
  const url = new URL("/OneBotv11", server.url);
  url.protocol = "ws:";
  const BunWebSocket = WebSocket as unknown as new (url: URL, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(url, { headers: {
    Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99",
  } });
  const calls: { action: string; params: Record<string, unknown>; echo: string }[] = [];
  const receipts: (number | undefined)[] = [8, 7, undefined, -103, 105];
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data);
    calls.push(frame);
    const response = frame.action === "send_msg" ? { message_id: receipts.shift() } : {};
    socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: response }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(JSON.stringify({ post_type: "message", message_type: "group", sub_type: "normal", message_id: 8,
      self_id: 99, group_id: 77, user_id: 42, message: "[CQ:reply,id=7]测试" }));
    const incoming = await event.promise;
    expect(incoming.reply_id).toBe("7");
    const recalls: RecallOwnReply[] = [];
    const options = { onOwnReply: (recall: RecallOwnReply) => { recalls.push(recall); } };
    for (let i = 0; i < 4; i++) expect(await incoming.reply("菜单", false, options)).toBe(true);
    expect(recalls).toHaveLength(1);
    expect(await Promise.all([recalls[0]!(), recalls[0]!()])).toEqual(["confirmed", "confirmed"]);
    expect(calls.filter(call => call.action === "delete_msg").map(call => call.params)).toEqual([{ message_id: -103 }]);
    expect(calls.filter(call => call.action === "send_msg").every(call => call.params.group_id === 77)).toBe(true);
    expect(await incoming.reply("下一页", false, options)).toBe(true);
    expect(recalls).toHaveLength(2);
    const closed = new Promise<void>(resolve => socket.addEventListener("close", () => resolve(), { once: true }));
    socket.close();
    await closed;
    expect(await recalls[1]!()).toBe("unknown");
    expect(calls.filter(call => call.action === "delete_msg")).toHaveLength(1);
  } finally {
    socket.close();
    server.stop(true);
  }
});

test("Milky 只用实际发件序号和固定群或好友目标撤回，未知结果不会重试", async () => {
  for (const group of [true, false]) {
    const recalls: RecallOwnReply[] = [];
    const calls: unknown[] = [];
    const receipt = [8, 7, undefined, 10];
    const incoming = milkyMessage({ self_id: 99, event_type: "message_receive",
      data: { message_scene: group ? "group" : "friend", peer_id: group ? 77 : 42, sender_id: 42, message_seq: 8,
        segments: [{ type: "reply", data: { message_seq: 7 } }, { type: "text", data: { text: "测试" } }] },
    }, 99, async () => ({ message_seq: receipt.shift() }), undefined, undefined, async (action, params) => {
      calls.push({ action, params });
      return { status: "unknown" };
    });
    const options = { onOwnReply: (recall: RecallOwnReply) => { recalls.push(recall); } };
    expect(await incoming?.reply("菜单", false, options)).toBe(true);
    expect(await incoming?.reply("菜单", false, options)).toBe(true);
    expect(await incoming?.reply("菜单", false, options)).toBe(false);
    expect(await incoming?.reply("菜单", false, options)).toBe(true);
    expect(recalls).toHaveLength(1);
    expect(await Promise.all([recalls[0]!(), recalls[0]!()])).toEqual(["unknown", "unknown"]);
    expect(calls).toEqual([group ? { action: "recall_group_message", params: { group_id: 77, message_seq: 10 } }
      : { action: "recall_private_message", params: { user_id: 42, message_seq: 10 } }]);
  }
});

test("Milky 已关闭会话的撤回句柄不会发送请求", async () => {
  const calls: unknown[] = [];
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const action = new URL(request.url).pathname.slice("/api/".length);
    const params = await request.json();
    calls.push({ action, params });
    return Response.json({ status: "ok", retcode: 0, data: action === "get_login_info" ? { uin: 99 } : { message_seq: 12 } });
  } });
  const runtime = new AbortController();
  const incoming = Promise.withResolvers<MessageEvent>();
  const recalls: RecallOwnReply[] = [];
  try {
    const session = await openMilkySession({
      apiBase: new URL("/api/", api.url), eventUrl: new URL("ws://127.0.0.1/event"), connection: "webhook",
      webhookPath: "/milky", accessToken: "own-reply-recall-fixture", timeoutMs: 1_000, reconnectMs: 10_000, heartbeatMs: 30_000,
    }, { signal: runtime.signal, async dispatch(event) { if (event.post_type === "message") incoming.resolve(event); } });
    expect(session?.receive({ self_id: 99, event_type: "message_receive",
      data: { message_scene: "friend", peer_id: 42, sender_id: 42, message_seq: 8,
        segments: [{ type: "text", data: { text: "测试" } }] },
    })).toBe("accepted");
    const event = await incoming.promise;
    const options = { onOwnReply: (recall: RecallOwnReply) => { recalls.push(recall); } };
    expect(await event.reply("菜单", false, options)).toBe(true);
    expect(await recalls[0]!()).toBe("confirmed");
    expect(await event.reply("另一个菜单", false, options)).toBe(true);
    runtime.abort();
    expect(await recalls[1]!()).toBe("rejected");
    expect(calls.map(call => (call as { action: string }).action)).toEqual([
      "get_login_info", "send_private_message", "recall_private_message", "send_private_message",
    ]);
    expect(calls[2]).toEqual({ action: "recall_private_message", params: { user_id: 42, message_seq: 12 } });
  } finally {
    runtime.abort();
    await api.stop(true);
  }
});
