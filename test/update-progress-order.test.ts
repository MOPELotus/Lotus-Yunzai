import { expect, test } from "bun:test";
import { startOneBot } from "../lib/adapters/onebot.ts";
import { OneBotGroups } from "../lib/adapters/onebot-groups.ts";
import { createUpdateCommand } from "../lib/update-command.ts";
import type { ManagedUpdateProgress } from "../lib/managed-update-protocol.ts";

const statuses: ManagedUpdateProgress[] = ["checking", "detail:atlas:checking", "detail:atlas:current", "detail:system:checking", "current"];

test("进度消息按收到顺序发送，静默仅省略正常进度和已是最新", async () => {
  const done = Promise.withResolvers<void>();
  const handler = createUpdateCommand((_event, _target, _quiet, report) => {
    statuses.forEach(report);
    return true;
  });
  const server = startOneBot(async event => {
    if (event.post_type !== "message") return;
    try { await handler(event); done.resolve(); } catch (error) { done.reject(error); }
  }, {
    hostname: "127.0.0.1", port: 0, groups: new OneBotGroups(), prewarmGroupMembers: false,
    auth: new Headers({ Authorization: "Bearer update-order-fixture" }), isMaster: () => true, masterIds: () => [42],
  });
  const url = new URL("/OneBotv11", server.url); url.protocol = "ws:";
  const Client = WebSocket as unknown as new (url: URL, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new Client(url, { headers: {
    Authorization: "Bearer update-order-fixture", "X-Client-Role": "Universal", "X-Self-ID": "99",
  } });
  const frames: { echo: string; params: { message: unknown } }[] = [];
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(String(data));
    if (frame.action === "send_msg") frames.push(frame);
    else socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: [] }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(JSON.stringify({ post_type: "message", message_type: "group", sub_type: "normal", message_id: 8,
      self_id: 99, group_id: 77, user_id: 42, message: "#全部更新" }));
    for (let index = 0; index < statuses.length; index++) {
      for (let wait = 0; frames.length <= index && wait < 100; wait++) await Bun.sleep(5);
      expect(frames).toHaveLength(index + 1);
      await Bun.sleep(20);
      expect(frames).toHaveLength(index + 1);
      expect(frames[index]!.echo).toBeTypeOf("string");
      socket.send(JSON.stringify({ echo: frames[index]!.echo, status: index === 1 ? "failed" : "ok",
        retcode: index === 1 ? 100 : 0, data: { message_id: index + 100 } }));
    }
    await done.promise;
    expect(frames.map(frame => frame.params.message)).toEqual([
      "开始更新，正在检查。", "正在检查 atlas。", "atlas 已是最新。", "正在检查 system。", "当前已是最新版本。",
    ]);
  } finally { socket.close(); server.stop(true); }
});
