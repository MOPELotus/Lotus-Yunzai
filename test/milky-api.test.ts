import { expect, test } from "bun:test";
import { createMilkyApi } from "../lib/adapters/milky-api.ts";
import type { MilkySettings } from "../lib/adapters/milky-config.ts";

function settings(base: URL, timeoutMs = 1_000): MilkySettings {
  return {
    apiBase: new URL("/milky/api/", base), eventUrl: new URL("ws://127.0.0.1/event"), connection: "webhook",
    webhookPath: "/milky", accessToken: "milky-api-fixture", timeoutMs, reconnectMs: 10_000, heartbeatMs: 30_000,
  };
}

test("Milky 出站 POST 发送鉴权和完整 JSON，仅返回已确认的数据对象", async () => {
  const requests: { path: string; method: string; token: string | null; contentType: string | null; json: unknown }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push({ path, method: request.method, token: request.headers.get("Authorization"),
      contentType: request.headers.get("Content-Type"), json: await request.json() });
    return Response.json({ status: "ok", retcode: 0, data: path.endsWith("get_login_info") ? { uin: 99 } : {} });
  } });
  try {
    const invoke = createMilkyApi(settings(server.url), new AbortController().signal);
    expect(await invoke("get_login_info", {})).toEqual({ uin: 99 });
    expect(await invoke("send_group_message", { group_id: 804, message: [{ type: "text", data: { text: "你好" } }] })).toEqual({});
    expect(requests).toEqual([
      { path: "/milky/api/get_login_info", method: "POST", token: "Bearer milky-api-fixture", contentType: "application/json", json: {} },
      { path: "/milky/api/send_group_message", method: "POST", token: "Bearer milky-api-fixture", contentType: "application/json",
        json: { group_id: 804, message: [{ type: "text", data: { text: "你好" } }] } },
    ]);
  } finally {
    await server.stop(true);
  }
});

test("Milky 遇到失败、畸形回执或重定向时不确认也不重试", async () => {
  const actions: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const action = new URL(request.url).pathname.split("/").at(-1)!;
    actions.push(action);
    switch (action) {
      case "redirect": return new Response(null, { status: 307, headers: { Location: "/should_not_receive" } });
      case "http_denied": return Response.json({ status: "ok", retcode: 0, data: {} }, { status: 401 });
      case "invalid_json": return new Response("{", { headers: { "Content-Type": "application/json" } });
      case "missing_fields": return Response.json({ data: {} });
      case "wrong_retcode": return Response.json({ status: "ok", retcode: "0", data: {} });
      case "failed": return Response.json({ status: "failed", retcode: 0, data: {} });
      case "array": return Response.json({ status: "ok", retcode: 0, data: [] });
      case "null": return Response.json({ status: "ok", retcode: 0, data: null });
      default: return Response.json({ status: "ok", retcode: 0, data: {} });
    }
  } });
  try {
    const invoke = createMilkyApi(settings(server.url), new AbortController().signal);
    const rejected = ["http_denied", "invalid_json", "missing_fields", "wrong_retcode", "failed", "array", "null", "redirect"];
    for (const action of rejected) expect(await invoke(action, {})).toBeUndefined();
    for (const action of ["../escape", "two/actions", "login?token=fixture", "http://127.0.0.1/action"]) {
      expect(await invoke(action, {})).toBeUndefined();
    }
    expect(actions).toEqual(rejected);
  } finally {
    await server.stop(true);
  }
});

test("Milky 超时和宿主取消都会中断已开始的回执读取", async () => {
  const seen: string[] = [];
  const abortStarted = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const action = new URL(request.url).pathname.split("/").at(-1)!;
    seen.push(action);
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"status":"ok","retcode":0,"data":'));
        if (action === "abort_me") abortStarted.resolve();
      },
    }), { headers: { "Content-Type": "application/json" } });
  } });
  try {
    const runtime = new AbortController();
    const timed = createMilkyApi(settings(server.url, 250), runtime.signal);
    expect(await timed("time_out", {})).toBeUndefined();
    const invoke = createMilkyApi(settings(server.url, 2_000), runtime.signal);
    const pending = invoke("abort_me", {});
    await abortStarted.promise;
    runtime.abort();
    expect(await pending).toBeUndefined();
    expect(await invoke("after_stop", {})).toBeUndefined();
    expect(seen).toEqual(["time_out", "abort_me"]);
  } finally {
    await server.stop(true);
  }
});
