import { expect, test } from "bun:test";
import type { MilkySettings } from "../lib/adapters/milky-config.ts";
import type { MilkyTransportOptions } from "../lib/adapters/milky-session.ts";
import { createMilkyWebhook } from "../lib/adapters/milky-webhook.ts";
import { createMilkyWs } from "../lib/adapters/milky-ws.ts";
import { notifyCheckin } from "../lib/checkin-notify.ts";

const token = "milky-checkin-fixture";
const botId = 99;
type Online = Parameters<NonNullable<MilkyTransportOptions["onOnline"]>>;
type ApiCall = { action: string; body: Record<string, unknown> };

function configuration(url: URL, connection: MilkySettings["connection"]): MilkySettings {
  const eventUrl = new URL("event", url);
  eventUrl.protocol = "ws:";
  return { apiBase: new URL("api/", url), eventUrl, connection, webhookPath: "/milky", accessToken: token,
    reconnectMs: 20, heartbeatMs: 1_000, timeoutMs: 2_000 };
}

function success(data: Record<string, unknown>) {
  return Response.json({ retcode: 0, status: "ok", data });
}

function rejected() {
  return Response.json({ retcode: 7, status: "failed" });
}

test("Milky Webhook 签到投递以已认证会话校验收件人，并区分拒绝和回执未知", async () => {
  const calls: ApiCall[] = [];
  let mode: "success" | "reject" | "bad-seq" | "network" = "success";
  const checking = Promise.withResolvers<void>();
  const sending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("Authorization") !== `Bearer ${token}` || request.method !== "POST") return new Response(null, { status: 401 });
    const action = new URL(request.url).pathname.replace(/^\/api\//u, "");
    const body = await request.json() as Record<string, unknown>;
    calls.push({ action, body });
    switch (action) {
      case "get_login_info": return success({ uin: botId });
      case "get_friend_info":
        if (body.user_id === 45) {
          checking.resolve();
          await release.promise;
        }
        return body.user_id === 44 ? success({}) : success({ friend: { user_id: body.user_id === 43 ? 42 : body.user_id } });
      case "get_group_member_info":
        return success({ member: { group_id: body.group_id === 78 ? 77 : body.group_id,
          user_id: body.user_id === 43 ? 42 : body.user_id } });
      case "send_private_message":
        if (body.user_id === 46) {
          sending.resolve();
          await release.promise;
          return success({ message_seq: 597 });
        }
        if (mode === "reject") return rejected();
        if (mode === "network") return new Response(null, { status: 503 });
        return success(mode === "bad-seq" ? { message_seq: null } : { message_seq: 0 });
      case "send_group_message": return success({ message_seq: 178 });
      default: return new Response(null, { status: 404 });
    }
  } });
  const controller = new AbortController();
  const first = Promise.withResolvers<Online>();
  const reconnected = Promise.withResolvers<Online>();
  let logins = 0;
  const webhook = createMilkyWebhook(configuration(gateway.url, "webhook"), {
    signal: controller.signal, async dispatch() {},
    onOnline(...online) { (++logins === 1 ? first : reconnected).resolve(online); },
  });
  try {
    webhook.start();
    const [id, session, send, notify] = await first.promise;
    expect(id).toBe(botId);
    expect(session.aborted).toBe(false);
    expect(await notify.isFriend(42)).toBe(true);
    expect(await notify.isFriend(43)).toBe(false);
    expect(await notify.isFriend(44)).toBe(false);
    expect(await notify.isGroupMember(77, 42)).toBe(true);
    expect(await notify.isGroupMember(78, 42)).toBe(false);
    expect(await notify.isGroupMember(77, 43)).toBe(false);
    expect(calls.slice(1)).toEqual([
      ...[42, 43, 44].map((user_id) => ({ action: "get_friend_info", body: { user_id, no_cache: true } })),
      ...[[77, 42], [78, 42], [77, 43]].map(([group_id, user_id]) => ({
        action: "get_group_member_info", body: { group_id, user_id, no_cache: true },
      })),
    ]);
    const beforeInvalid = calls.length;
    expect(await notify.isFriend(0)).toBe(false);
    expect(await notify.isGroupMember(77, NaN)).toBe(false);
    expect(await notify.sendPrivate(0, "签到")).toBe("rejected");
    expect(await notify.sendGroup(77, [])).toBe("rejected");
    expect(calls.length).toBe(beforeInvalid);
    expect(await send({ user_id: 42 }, "旧消息")).toBe(true);

    const options = {
      userId: 42, settings: { enabled: true, prefer: "private" as const, fallbackGroups: [77] },
      reply: "签到", transports: [notify],
    };
    mode = "reject";
    expect(await notifyCheckin(options)).toEqual({ status: "confirmed", channel: "group", groupId: 77 });
    expect(calls.slice(-4)).toEqual([
      { action: "get_friend_info", body: { user_id: 42, no_cache: true } },
      { action: "send_private_message", body: { user_id: 42, message: [{ type: "text", data: { text: "签到" } }] } },
      { action: "get_group_member_info", body: { group_id: 77, user_id: 42, no_cache: true } },
      { action: "send_group_message", body: { group_id: 77, message: [
        { type: "mention", data: { user_id: 42 } },
        { type: "text", data: { text: "\n" } },
        { type: "text", data: { text: "签到" } },
      ] } },
    ]);
    for (const outcome of ["bad-seq", "network"] as const) {
      mode = outcome;
      const before = calls.length;
      expect(await notifyCheckin(options)).toEqual({ status: "unknown", channel: "private" });
      expect(calls.slice(before).map(({ action }) => action)).toEqual(["get_friend_info", "send_private_message"]);
      expect(await send({ user_id: 42 }, "旧消息")).toBe(false);
    }
    expect(await notify.isFriend(46)).toBe(true);
    const staleCheck = notify.isFriend(45);
    const interruptedSend = notify.sendPrivate(46, "签到");
    await Promise.all([checking.promise, sending.promise]);
    const offline = await webhook.handle(new Request("http://localhost/milky", { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ self_id: botId, event_type: "bot_offline", data: {} }),
    }), new Headers());
    expect(offline?.status).toBe(200);
    expect(session.aborted).toBe(true);
    release.resolve();
    expect(await staleCheck).toBe(false);
    expect(await interruptedSend).toBe("unknown");
    const [, freshSignal, , fresh] = await reconnected.promise;
    expect(fresh).not.toBe(notify);
    expect(freshSignal.aborted).toBe(false);
    const beforeStale = calls.length;
    expect(await notify.isFriend(42)).toBe(false);
    expect(await notify.isGroupMember(77, 42)).toBe(false);
    expect(await notify.sendPrivate(42, "签到")).toBe("rejected");
    expect(await notify.sendGroup(77, "签到")).toBe("rejected");
    expect(calls.length).toBe(beforeStale);
  } finally {
    release.resolve();
    await webhook.stop();
    gateway.stop(true);
  }
});

test("Milky WS 只在事件连接开放时交出签到投递，并在停机撤销", async () => {
  const upgrade = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const online = Promise.withResolvers<Online>();
  const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, server) {
    if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === "/event") {
      upgrade.resolve();
      await release.promise;
      if (server.upgrade(request)) return;
    }
    if (path === "/api/get_login_info") return success({ uin: botId });
    if (path === "/api/get_friend_info") return success({ friend: { user_id: 24 } });
    return new Response(null, { status: 404 });
  }, websocket: { message() {} } });
  let bound = false;
  const controller = new AbortController();
  const ws = createMilkyWs(configuration(gateway.url, "ws"), {
    signal: controller.signal, async dispatch() {},
    onOnline(...session) { bound = true; online.resolve(session); },
  });
  try {
    ws.start();
    await upgrade.promise;
    expect(bound).toBe(false);
    release.resolve();
    const [id, signal, , notify] = await online.promise;
    expect(id).toBe(botId);
    expect(await notify.isFriend(24)).toBe(true);
    await ws.stop();
    expect(signal.aborted).toBe(true);
    expect(await notify.isFriend(24)).toBe(false);
  } finally {
    release.resolve();
    await ws.stop();
    gateway.stop(true);
  }
});
