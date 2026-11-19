import { expect, test } from "bun:test";
import { openMilkySession } from "../lib/adapters/milky-session.ts";
import type { MessageEvent } from "../lib/messages.ts";

test("Milky 后台通知仅将有消息序号的发送按当前机器人和目标统计一次", async () => {
  const requests: { action: string; params: unknown }[] = [];
  const sent: { identity: unknown; message: unknown }[] = [];
  const ok = (data: object) => Response.json({ status: "ok", retcode: 0, data });
  const replies = [
    () => ok({ message_seq: 0 }),
    () => ok({ message_seq: 4 }),
    () => ok({}),
    () => Response.json({ status: "failed", retcode: -403 }),
    () => ok({ message_seq: 0 }),
    () => ok({}),
  ];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const action = new URL(request.url).pathname.split("/").at(-1)!;
    if (action === "get_login_info") return ok({ uin: 99 });
    requests.push({ action, params: await request.json() });
    return replies.shift()?.() ?? new Response(null, { status: 500 });
  } });
  const runtime = new AbortController();
  const incoming = Promise.withResolvers<MessageEvent>();
  try {
    const session = await openMilkySession({
      apiBase: new URL("/api/", server.url), eventUrl: new URL("ws://127.0.0.1/event"), connection: "webhook",
      webhookPath: "/milky", accessToken: "notification-fixture", timeoutMs: 1_000, reconnectMs: 10_000, heartbeatMs: 30_000,
    }, {
      signal: runtime.signal,
      async dispatch(event) { if (event.post_type === "message") incoming.resolve(event); },
      onSent: (identity, message) => { sent.push({ identity, message }); },
    });
    const notifications = session?.checkinNotify;
    if (!notifications?.sendForward) throw new Error("缺少 Milky 后台通知能力。");

    expect(await notifications.sendPrivate(51, "私聊通知")).toBe("confirmed");
    expect(await notifications.sendForward({ groupId: 77 }, ["标题", "正文"])).toBe("confirmed");
    expect(await notifications.sendGroup(77, "无序号")).toBe("unknown");
    expect(await notifications.sendForward({ userId: 51 }, ["明确拒绝"])).toBe("rejected");
    expect(session!.receive({
      self_id: 99, event_type: "message_receive", data: {
        time: 1_700_000_000, message_scene: "friend", sender_id: 51, peer_id: 51, message_seq: 7,
        segments: [{ type: "text", data: { text: "测试" } }],
      },
    })).toBe("accepted");
    const { reply } = await incoming.promise;
    const receipts: number[] = [];
    const onDelivered = (id: number) => { receipts.push(id); };
    expect(await reply("有序号", false, { onDelivered })).toBe(true);
    expect(await reply("缺序号", false, { onDelivered })).toBe(false);
    expect(receipts).toEqual([0]);
    runtime.abort();
    expect(await notifications.sendPrivate(51, "连接已断")).toBe("rejected");

    expect(requests.map(({ action }) => action)).toEqual([
      "send_private_message", "send_group_message", "send_group_message", "send_private_message",
      "send_private_message", "send_private_message",
    ]);
    expect(sent).toEqual([
      { identity: { self_id: 99, group_id: undefined, user_id: 51 },
        message: [{ type: "text", data: { text: "私聊通知" } }] },
      { identity: { self_id: 99, group_id: 77, user_id: undefined },
        message: (requests[1]!.params as { message: unknown }).message },
      { identity: { self_id: 99, group_id: undefined, user_id: 51 },
        message: [{ type: "text", data: { text: "有序号" } }] },
    ]);
    expect(sent[1]!.message).toMatchObject([{ type: "forward" }]);
  } finally {
    runtime.abort();
    await server.stop(true);
  }
});
