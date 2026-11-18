import { expect, test } from "bun:test";
import { createMilkyWebhook } from "../lib/adapters/milky-webhook.ts";

test("未配置 Milky 令牌时，Webhook 只信任通过 HTTP 鉴权的事件", async () => {
  const controller = new AbortController();
  const gateway = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => Response.json({ status: "ok", retcode: 0, data: { uin: 99 } }),
  });
  const received: number[] = [];
  const path = "/milky";
  const listenerAuth = new Headers({ Authorization: "Bearer host-fixture" });
  const adapter = createMilkyWebhook({
    apiBase: new URL("/api/", gateway.url), eventUrl: new URL("ws://127.0.0.1/event"),
    connection: "webhook", webhookPath: path, timeoutMs: 1_000, reconnectMs: 100, heartbeatMs: 100,
  }, {
    signal: controller.signal,
    async dispatch(event) { received.push(event.user_id!); },
  });

  function request(headers?: HeadersInit) {
    return new Request(`http://127.0.0.1${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
      body: JSON.stringify({ event_type: "message_receive", self_id: 99, data: {
        message_scene: "friend", sender_id: 42, peer_id: 42, message_seq: 1,
        segments: [{ type: "text", data: { text: "#清除登录" } }],
      } }),
    });
  }

  try {
    adapter.start();
    const deadline = performance.now() + 2_000;
    while (true) {
      const response = await adapter.handle(request(listenerAuth), listenerAuth);
      if (response?.status !== 503 || performance.now() >= deadline) {
        expect(response?.status).toBe(200);
        break;
      }
      await Bun.sleep(15);
    }

    expect((await adapter.handle(request(), new Headers()))?.status).toBe(401);
    expect((await adapter.handle(request(), listenerAuth))?.status).toBe(401);
    expect(received).toEqual([42]);
  } finally {
    controller.abort();
    await adapter.stop();
    gateway.stop(true);
  }
});
