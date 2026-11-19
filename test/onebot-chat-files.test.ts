import { expect, test } from "bun:test";
import type { ChatFile } from "../lib/chat-files.ts";
import type { MessageEvent } from "../lib/messages.ts";
import { startOneBot } from "../lib/adapters/onebot.ts";
import { OneBotGroups } from "../lib/adapters/onebot-groups.ts";

interface Frame {
  readonly action: string;
  readonly params: unknown;
  readonly echo: string;
}

const file: ChatFile = { name: "祈愿记录.json", bytes: new Uint8Array([0, 42, 255]) };
const token = "onebot-chat-files-fixture";

function deadline<T>(pending: Promise<T>, label: string): Promise<T> {
  const { promise, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error(`等待 ${label} 超时`)), 1_500);
  return Promise.race([pending, promise]).finally(() => clearTimeout(timer));
}

test("OneBot 文件发送绑定当前群或私聊用户，区分拒绝、确认和不确定回执", async () => {
  const events = new Map<number, (event: MessageEvent) => void>();
  const server = startOneBot(async (event) => {
    if (event.post_type === "message" && event.message_id !== undefined) events.get(event.message_id)?.(event);
  }, {
    hostname: "127.0.0.1", port: 0, groups: new OneBotGroups(),
    auth: new Headers({ Authorization: `Bearer ${token}` }), isMaster: () => false, masterIds: () => [],
  });
  const url = new URL("/OneBotv11", server.url);
  url.protocol = "ws:";
  const sockets: WebSocket[] = [];
  const BunWebSocket = WebSocket as unknown as new (url: URL, options: Bun.WebSocketOptions) => WebSocket;

  async function connect(botId?: number) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal" };
    if (botId !== undefined) headers["X-Self-ID"] = String(botId);
    const socket = new BunWebSocket(url, { headers });
    sockets.push(socket);
    const frames: Frame[] = [];
    socket.addEventListener("message", ({ data }) => frames.push(JSON.parse(data)));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("OneBot 连接失败")), { once: true });
    await deadline(promise, "OneBot 连接");
    return { socket, frames };
  }

  let sequence = 0;
  async function message(socket: WebSocket, fields: Record<string, unknown> = {}) {
    const id = ++sequence;
    const { promise, resolve } = Promise.withResolvers<MessageEvent>();
    events.set(id, resolve);
    socket.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend",
      self_id: 99, user_id: 42, message_id: id, message: "测试", ...fields }));
    try {
      return await deadline(promise, "消息事件");
    } finally {
      events.delete(id);
    }
  }

  try {
    const gateway = await connect(99);
    const group = await message(gateway.socket, { message_type: "group", sub_type: "normal", group_id: 77 });
    const friend = await message(gateway.socket);
    const temporary = await message(gateway.socket, { sub_type: "group", group_id: 77, user_id: 43 });
    const unbound = await connect();
    expect((await message(unbound.socket)).uploadFile).toBeUndefined();

    async function send(event: MessageEvent, receipt?: Record<string, unknown>) {
      if (!event.uploadFile) throw new Error("消息缺少文件发送能力");
      const { promise, resolve } = Promise.withResolvers<Frame>();
      gateway.socket.addEventListener("message", ({ data }) => resolve(JSON.parse(data)), { once: true });
      const result = event.uploadFile(file);
      const frame = await deadline(promise, "文件发送请求");
      expect(frame.echo).toBeString();
      if (receipt) gateway.socket.send(JSON.stringify({ echo: frame.echo, ...receipt }));
      else gateway.socket.close();
      return { frame, result: await deadline(result, "文件发送回执") };
    }

    expect(await group.uploadFile?.({ ...file, name: "../记录.json" })).toBe("rejected");
    const sentGroup = await send(group, { status: "ok", retcode: 0, data: { file_id: "uploaded" } });
    expect(sentGroup.frame.action).toBe("upload_group_file");
    expect(sentGroup.frame.params).toEqual({ group_id: 77, file: "base64://ACr/", name: file.name });
    expect(sentGroup.result).toBe("confirmed");

    const sentFriend = await send(friend, { status: "failed", retcode: 1404 });
    expect(sentFriend.frame.action).toBe("upload_private_file");
    expect(sentFriend.frame.params).toEqual({ user_id: 42, file: "base64://ACr/", name: file.name });
    expect(sentFriend.result).toBe("rejected");
    const sentTemporary = await send(temporary, { status: "ok", retcode: 0, data: { file_id: "uploaded" } });
    expect(sentTemporary.frame.action).toBe("upload_private_file");
    expect(sentTemporary.frame.params).toEqual({ user_id: 43, file: "base64://ACr/", name: file.name });
    expect(sentTemporary.result).toBe("confirmed");
    expect((await send(friend, { status: "ok", retcode: 0, data: { file_id: null } })).result).toBe("unknown");
    expect((await send(friend)).result).toBe("unknown");
    expect(gateway.frames.map(({ action }) => action)).toEqual([
      "upload_group_file", "upload_private_file", "upload_private_file", "upload_private_file", "upload_private_file",
    ]);

    const previous = await connect(99);
    const oldFriend = await message(previous.socket);
    const replacement = await connect(99);
    expect((await message(replacement.socket)).uploadFile).toBeFunction();
    expect((await message(previous.socket)).uploadFile).toBeUndefined();
    expect(await oldFriend.uploadFile?.(file)).toBe("rejected");
    expect(previous.frames).toEqual([]);
    expect(replacement.frames).toEqual([]);
  } finally {
    sockets.forEach((socket) => socket.close());
    await server.stop(true);
  }
}, 8_000);
