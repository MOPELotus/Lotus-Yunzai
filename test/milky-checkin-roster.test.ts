import { expect, test } from "bun:test";
import { createMilkyWebhook } from "../lib/adapters/milky-webhook.ts";
import type { MessageEvent } from "../lib/messages.ts";

const token = "milky-roster-fixture";
const botId = 99;
const groupId = 77;

function success(data: Record<string, unknown>) {
  return Response.json({ retcode: 0, status: "ok", data });
}

test("Milky 从群消息的已认证会话读取实时成员，拒绝不完整名单及过期会话", async () => {
  const calls: unknown[] = [];
  const requestStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let answer = (): Response | Promise<Response> => success({ members: [] });
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) {
      return new Response(null, { status: 401 });
    }
    switch (new URL(request.url).pathname) {
      case "/api/get_login_info": return success({ uin: botId });
      case "/api/get_group_member_list":
        calls.push(await request.json());
        return answer();
      default: return new Response(null, { status: 404 });
    }
  } });
  const first = Promise.withResolvers<AbortSignal>();
  const reconnected = Promise.withResolvers<AbortSignal>();
  let logins = 0;
  let dispatched = Promise.withResolvers<MessageEvent>();
  const webhook = createMilkyWebhook({
    apiBase: new URL("/api/", gateway.url), eventUrl: new URL("/event", gateway.url), connection: "webhook",
    webhookPath: "/milky", accessToken: token, reconnectMs: 20, heartbeatMs: 1_000, timeoutMs: 2_000,
  }, {
    signal: new AbortController().signal,
    async dispatch(event) { if (event.post_type === "message") dispatched.resolve(event); },
    onOnline(_bot, signal) { (++logins === 1 ? first : reconnected).resolve(signal); },
  });

  async function send(event_type: string, data: Record<string, unknown>) {
    const response = await webhook.handle(new Request("http://localhost/milky", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ self_id: botId, event_type, data }),
    }), new Headers());
    expect(response?.status).toBe(200);
  }

  let sequence = 0;
  async function message(message_scene: "friend" | "group", peer_id: number) {
    dispatched = Promise.withResolvers<MessageEvent>();
    await send("message_receive", {
      message_scene, sender_id: 42, peer_id, message_seq: ++sequence,
      segments: [{ type: "text", data: { text: "#签到名单列表" } }],
    });
    return dispatched.promise;
  }

  try {
    webhook.start();
    const oldSession = await first.promise;
    expect((await message("friend", 42)).listCheckinGroupMembers).toBeUndefined();
    const read = (await message("group", groupId)).listCheckinGroupMembers;
    if (!read) throw new Error("群消息缺少成员名单接口");
    expect(calls).toHaveLength(0);

    const member = { group_id: groupId, user_id: 42, card: " 群名片 ", nickname: "昵称" };
    answer = () => success({ members: [
      member,
      { group_id: groupId, user_id: 43, card: " ", nickname: " 备用昵称 " },
      { group_id: groupId, user_id: 44, card: "", nickname: "" },
    ] });
    expect(await read()).toEqual([{ id: 42, name: "群名片" }, { id: 43, name: "备用昵称" }, { id: 44 }]);
    answer = () => success({ members: [] });
    expect(await read()).toEqual([]);

    const maxRoster = Array.from({ length: 10_000 }, (_, index) => ({ group_id: groupId, user_id: index + 1 }));
    answer = () => success({ members: maxRoster });
    expect(await read()).toHaveLength(10_000);
    const invalidRosters = [
      undefined,
      { group_id: groupId, user_id: 42 },
      [member, member],
      [member, { ...member, group_id: groupId + 1, user_id: 43 }],
      [{ user_id: 42 }],
      [{ ...member, user_id: "42" }],
      [{ ...member, user_id: 0 }],
      [{ ...member, user_id: 2 ** 53 }],
      [...maxRoster, { group_id: groupId, user_id: 10_001 }],
    ];
    for (const members of invalidRosters) {
      answer = () => success({ members });
      expect(await read()).toBeUndefined();
    }
    answer = () => new Response(null, { status: 503 });
    expect(await read()).toBeUndefined();
    answer = () => new Response("{");
    expect(await read()).toBeUndefined();
    answer = () => Response.json({ retcode: 7, status: "failed" });
    expect(await read()).toBeUndefined();
    expect(calls).toEqual(Array.from({ length: invalidRosters.length + 6 }, () => ({ group_id: groupId, no_cache: true })));

    answer = async () => {
      requestStarted.resolve();
      await release.promise;
      return success({ members: [member] });
    };
    const pending = read();
    await requestStarted.promise;
    await send("bot_offline", {});
    expect(oldSession.aborted).toBe(true);
    release.resolve();
    expect(await pending).toBeUndefined();
    expect((await reconnected.promise).aborted).toBe(false);
    const beforeReplacementRead = calls.length;
    expect(await read()).toBeUndefined();
    expect(calls).toHaveLength(beforeReplacementRead);

    const otherGroup = groupId + 1;
    answer = () => success({ members: [{ ...member, group_id: otherGroup, card: "新会话" }] });
    const fresh = (await message("group", otherGroup)).listCheckinGroupMembers;
    if (!fresh) throw new Error("新会话群消息缺少成员名单接口");
    expect(await fresh()).toEqual([{ id: 42, name: "新会话" }]);
    expect(calls.slice(beforeReplacementRead)).toEqual([{ group_id: otherGroup, no_cache: true }]);
  } finally {
    release.resolve();
    await webhook.stop();
    gateway.stop(true);
  }
});
