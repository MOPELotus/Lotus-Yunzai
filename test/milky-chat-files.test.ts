import { expect, test } from "bun:test";
import { openMilkySession } from "../lib/adapters/milky-session.ts";
import type { MessageEvent } from "../lib/messages.ts";

test("Milky 只向事件原会话上传文件，按真实 file_id 确认且不重试", async () => {
  const requests: { action: string; method: string; auth: string | null; params: unknown }[] = [];
  const reply = (data: object) => Response.json({ status: "ok", retcode: 0, data });
  const responses = [
    () => reply({ file_id: "private-file" }),
    () => reply({ file_id: "group/file" }),
    () => Response.json({ status: "failed", retcode: -403 }),
    () => reply({ file_id: "" }),
    () => new Response(null, { status: 502 }),
  ];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const action = new URL(request.url).pathname.slice("/api/".length);
    if (action === "get_login_info") return reply({ uin: 99 });
    requests.push({ action, method: request.method, auth: request.headers.get("Authorization"), params: await request.json() });
    return responses.shift()?.() ?? new Response(null, { status: 500 });
  } });
  const runtime = new AbortController();
  try {
    const group = Promise.withResolvers<MessageEvent>();
    const friend = Promise.withResolvers<MessageEvent>();
    const session = await openMilkySession({
      apiBase: new URL("/api/", server.url), eventUrl: new URL("ws://127.0.0.1/event"), connection: "webhook",
      webhookPath: "/milky", accessToken: "milky-chat-file-fixture", timeoutMs: 1_000, reconnectMs: 10_000, heartbeatMs: 30_000,
    }, {
      signal: runtime.signal,
      async dispatch(event) {
        if (event.post_type === "message") (event.isGroup ? group : friend).resolve(event);
      },
    });
    if (!session) throw new Error("Milky 登录失败。");
    for (const scene of ["friend", "group"]) {
      expect(session.receive({
        self_id: 99, event_type: "message_receive",
        data: {
          message_scene: scene, sender_id: 200, peer_id: scene === "group" ? 300 : 200, message_seq: 1,
          segments: [{ type: "text", data: { text: "测试" } }],
        },
      })).toBe("accepted");
    }
    const { uploadFile: uploadPrivate } = await friend.promise;
    const { uploadFile: uploadGroup } = await group.promise;
    if (!uploadPrivate || !uploadGroup) throw new Error("缺少 Milky 上传能力。");
    const file = { name: "数据.json", bytes: Uint8Array.of(0, 1, 255) };
    expect(await uploadPrivate({ ...file, name: "../数据.json" })).toBe("rejected");
    expect(await uploadPrivate(file)).toBe("confirmed");
    expect(await uploadGroup(file)).toBe("confirmed");
    expect(await uploadGroup(file)).toBe("rejected");
    expect(await uploadPrivate(file)).toBe("unknown");
    expect(await uploadPrivate(file)).toBe("unknown");
    runtime.abort();
    expect(await uploadGroup(file)).toBe("rejected");
    const fileParams = { file_uri: "base64://AAH/", file_name: file.name };
    const privateRequest = { action: "upload_private_file", method: "POST", auth: "Bearer milky-chat-file-fixture",
      params: { user_id: 200, ...fileParams } };
    const groupRequest = { action: "upload_group_file", method: "POST", auth: "Bearer milky-chat-file-fixture",
      params: { group_id: 300, parent_folder_id: "/", ...fileParams } };
    expect(requests).toEqual([privateRequest, groupRequest, groupRequest, privateRequest, privateRequest]);
  } finally {
    runtime.abort();
    await server.stop(true);
  }
});
