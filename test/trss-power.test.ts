import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const oneBotToken = "power-onebot-fixture";
const httpToken = "power-http-fixture";

interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: Readonly<Record<string, unknown>>;
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 2_500);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function endpointOf(stdout: ReadableStream<Uint8Array>) {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`开关机测试宿主未启动 OneBot。\n${output}`);
      output += decoder.decode(chunk.value, { stream: true });
      const match = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output);
      if (match) return match[0];
    }
  } finally {
    reader.releaseLock();
  }
}

function connect(endpoint: string, botId?: number) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const headers: Record<string, string> = { Authorization: `Bearer ${oneBotToken}`, "X-Client-Role": "Universal" };
  if (botId !== undefined) headers["X-Self-ID"] = String(botId);
  const socket = new BunWebSocket(endpoint, { headers });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const frames: Frame[] = [];
  let ready = Promise.withResolvers<void>();
  socket.addEventListener("message", ({ data }) => {
    frames.push(JSON.parse(data));
    ready.resolve();
  });

  function send(event: object) {
    socket.send(JSON.stringify({ self_id: botId ?? 99, ...event }));
  }
  let messageId = 0;
  return {
    socket, opened, frames,
    async next() {
      if (!frames.length) await deadline(ready.promise, "没有收到开关机测试 OneBot 动作。");
      const frame = frames.shift()!;
      if (!frames.length) ready = Promise.withResolvers<void>();
      return frame;
    },
    command(message: string, userId: number, groupId?: number) {
      send({
        post_type: "message", message_type: groupId ? "group" : "private", sub_type: groupId ? "normal" : "friend",
        user_id: userId, group_id: groupId, message_id: ++messageId, message, sender: { role: "owner" },
      });
    },
    poke(userId: number) {
      send({ post_type: "notice", notice_type: "notify", sub_type: "poke", user_id: userId, target_id: botId });
    },
    friendRequest(flag: string, userId = 42) {
      send({ post_type: "request", request_type: "friend", sub_type: "add", user_id: userId, flag });
    },
    confirm(frame: Frame) {
      expect(typeof frame.echo).toBe("string");
      send({ echo: frame.echo, status: "ok", retcode: 0 });
    },
  };
}

type Gateway = ReturnType<typeof connect>;

async function expectPrivateStatus(client: Gateway, userId: number) {
  client.command("#状态", userId);
  expect(await client.next()).toMatchObject({
    action: "send_msg", params: { user_id: userId, message: expect.stringContaining("Lotus-Yunzai 正在运行") },
  });
}

async function expectGroupStatus(client: Gateway) {
  client.command("#状态", 42, 77);
  expect(await client.next()).toMatchObject({
    action: "send_msg", params: { group_id: 77, message: expect.stringContaining("Lotus-Yunzai 正在运行") },
  });
}

async function expectLegacyEvents(client: Gateway, flag: string) {
  client.poke(42);
  expect(await client.next()).toMatchObject({
    action: "send_msg", params: { user_id: 42, message: "开关机戳一戳夹具" },
  });
  client.friendRequest(flag);
  const approval = await client.next();
  expect(approval).toMatchObject({ action: "set_friend_add_request", params: { flag, approve: true } });
  client.confirm(approval);
}

test("主人关机和开机在多个 OneBot 账号间暂停和恢复全局派发", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-power-"));
  const clients: Gateway[] = [];
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51", "100:52"]\n'),
      writeFile(join(root, "plugins/power-fixture.js"), `
        export const apps = {
          poke: class extends plugin {
            constructor() { super({ event: "notice.friend.poke", rule: [{ fnc: "poke" }] }); }
            poke(e) { return e.reply("开关机戳一戳夹具"); }
          },
          approve: class extends plugin {
            constructor() { super({ event: "request.friend.add" }); }
            async accept(e) { if (await e.approve(true)) return "return"; }
          },
        };
      `),
    ]);
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0",
        LOTUS_HTTP_TOKEN: httpToken, LOTUS_ONEBOT_TOKEN: oneBotToken,
      },
    });
    const stderr = new Response(host.stderr).text();
    const endpoint = await deadline(endpointOf(host.stdout), "开关机测试宿主启动超时。");
    const statusUrl = new URL("/status", endpoint.replace(/^ws/u, "http"));
    const status = async () => {
      const response = await fetch(statusUrl, {
        headers: { Authorization: `Bearer ${httpToken}` }, signal: AbortSignal.timeout(2_000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ok", name: "Lotus-Yunzai" });
    };
    const open = async (botId?: number) => {
      const client = connect(endpoint, botId);
      clients.push(client);
      await deadline(client.opened, "开关机测试网关连接超时。");
      return client;
    };

    const first = await open(99);
    await status();
    first.command("#关机", 42);
    expect(await first.next()).toMatchObject({
      action: "send_msg", params: { user_id: 42, message: "暂无权限，只有主人才能操作" },
    });
    await expectGroupStatus(first);
    await expectLegacyEvents(first, "fixture-before-power-off");

    first.command("#关机", 51);
    const off = await first.next();
    expect(off).toMatchObject({ action: "send_msg", params: { user_id: 51 } });
    expect(off.params.message).toMatch(/^关机成功/u);

    // The listener still accepts new OneBot connections while event dispatch is paused.
    const second = await open(100);
    const unbound = await open();
    await status();
    first.command("#开机", 42);
    second.command("#开机", 51);
    unbound.command("#开机", 51);
    first.command("#状态", 51);
    second.command("#状态", 42, 77);
    first.poke(42);
    second.friendRequest("fixture-while-powered-off");
    await Bun.sleep(150);
    for (const { frames } of clients) expect(frames).toEqual([]);

    second.command("#开机", 52);
    const on = await second.next();
    expect(on).toMatchObject({ action: "send_msg", params: { user_id: 52 } });
    expect(on.params.message).toMatch(/^开机成功/u);
    await expectPrivateStatus(first, 42);
    await expectGroupStatus(second);
    await expectLegacyEvents(second, "fixture-after-power-on");
    await status();

    host.kill();
    expect(await deadline(host.exited, "开关机测试宿主退出超时。")).toBe(143);
    expect(await stderr).not.toContain("处理 OneBot 事件失败");
    for (const { frames } of clients) expect(frames).toEqual([]);
  } finally {
    for (const { socket } of clients) socket.close();
    if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
