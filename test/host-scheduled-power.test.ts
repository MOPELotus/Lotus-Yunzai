import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const oneBotToken = "scheduled-power-onebot-fixture";
const httpToken = "scheduled-power-http-fixture";
const milkyToken = "scheduled-power-milky-fixture";

interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: { readonly message: string; readonly message_type: string; readonly user_id: number };
}

async function waitFor<T>(read: () => T | undefined, description: string, timeout = 2_000): Promise<T> {
  const end = performance.now() + timeout;
  do {
    const result = read();
    if (result !== undefined) return result;
    await Bun.sleep(5);
  } while (performance.now() < end);
  throw new Error(description);
}

function connect(url: string, id?: number) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const headers: Record<string, string> = { Authorization: `Bearer ${oneBotToken}`, "X-Client-Role": "Universal" };
  if (id !== undefined) headers["X-Self-ID"] = String(id);
  const socket = new BunWebSocket(url, { headers });
  const frames: Frame[] = [];
  socket.addEventListener("message", ({ data }) => {
    const frame: Frame = JSON.parse(data);
    frames.push(frame);
    if (frame.echo) socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 7 } }));
  });
  let messageId = 0;
  return {
    socket, frames,
    next: () => waitFor(() => frames.shift(), "未收到定时开关机的 OneBot 回复。", 6_000),
    probe(userId: number) {
      socket.send(JSON.stringify({
        post_type: "message", message_type: "private", sub_type: "friend", self_id: id ?? 99,
        user_id: userId, message_id: ++messageId, message: "#状态",
      }));
    },
  };
}

function milkyGateway(botId: number) {
  let client: Bun.ServerWebSocket<undefined> | undefined;
  const frames: { readonly user_id: number; readonly message: readonly { type: string; data: { text: string } }[] }[] = [];
  let replySeq = 0;
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, gateway) {
      if (request.headers.get("Authorization") !== `Bearer ${milkyToken}`) return new Response(null, { status: 401 });
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/event" && gateway.upgrade(request)) return;
      if (request.method === "POST" && pathname === "/api/get_login_info") {
        return Response.json({ status: "ok", retcode: 0, data: { uin: botId } });
      }
      if (request.method === "POST" && pathname === "/api/send_private_message") {
        frames.push(await request.json() as typeof frames[number]);
        return Response.json({ status: "ok", retcode: 0, data: { message_seq: ++replySeq } });
      }
      return new Response(null, { status: 404 });
    },
    websocket: { open(socket) { client = socket; }, message() {} },
  });
  let messageSeq = 0;
  return {
    port: server.port, frames, close: () => server.stop(true),
    async probe(userId: number) {
      const socket = await waitFor(() => client, "定时开关机的 Milky 网关未连接。");
      socket.send(JSON.stringify({ event_type: "message_receive", self_id: botId, data: {
        message_scene: "friend", peer_id: userId, sender_id: userId, message_seq: ++messageSeq,
        segments: [{ type: "text", data: { text: "#状态" } }],
      } }));
    },
    async expectMessage(owner: number, prefix: RegExp) {
      const frame = await waitFor(() => frames.shift(), "未收到定时开关机的 Milky 回复。", 6_000);
      expect(frame.user_id).toBe(owner);
      expect(frame.message).toEqual([{ type: "text", data: { text: expect.stringMatching(prefix) } }]);
    },
  };
}

async function exerciseScheduledPower(milkyId: 100 | 104) {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-scheduled-power-"));
  const clients: ReturnType<typeof connect>[] = [];
  const milky = milkyGateway(milkyId);
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51", "100:52", "101:53", "104:54"]\n'),
      writeFile(join(root, "config/milky.yaml"), [
        "enable: true", "host: 127.0.0.1", `port: ${milky.port}`, `access_token: ${milkyToken}`, "",
      ].join("\n")),
      writeFile(join(root, "config/config/bot.yaml"), [
        'stop_cron: "0 13 * * *"',
        'start_cron: ["2 0 13 * * *", "15 13 * * *"]',
        "",
      ].join("\n")),
      // Move this child close to a minute boundary. The actual scheduler and its timers still run.
      writeFile(join(root, "fixture-clock.js"), `
        const DateConstructor = Date;
        const origin = DateConstructor.parse("2032-04-14T04:59:56.000Z") - performance.now();
        const now = () => Math.floor(origin + performance.now());
        globalThis.Date = new Proxy(DateConstructor, {
          get: (target, key, receiver) => key === "now" ? now : Reflect.get(target, key, receiver),
          construct: (target, args, constructor) => Reflect.construct(target, args.length ? args : [now()], constructor),
          apply: () => new DateConstructor(now()).toString(),
        });
      `),
    ]);

    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "--preload", "./fixture-clock.js", "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH, TZ: "UTC", LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0",
        LOTUS_HTTP_TOKEN: httpToken, LOTUS_ONEBOT_TOKEN: oneBotToken,
      },
    });
    const stderr = new Response(host.stderr).text();
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    const stop = setTimeout(() => host.kill("SIGKILL"), 12_000);
    try {
      let output = "";
      let endpoint: string | undefined;
      while (!endpoint) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`定时开关机测试宿主未启动。\n${output}\n${await stderr}`);
        output += decoder.decode(chunk.value, { stream: true });
        endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      }
      const first = connect(endpoint, 99);
      const second = connect(endpoint, 100);
      const unbound = connect(endpoint);
      clients.push(first, second, unbound);
      await waitFor(() => clients.every(({ socket }) => socket.readyState === WebSocket.OPEN) || undefined,
        "定时开关机测试网关未连接。");

      first.probe(42);
      expect((await first.next()).params.message).toMatch(/^Lotus-Yunzai 正在运行/u);
      await milky.probe(42);
      await milky.expectMessage(42, /^Lotus-Yunzai 正在运行/u);

      async function expectNotification(client: typeof first, owner: number, prefix: RegExp) {
        const frame = await client.next();
        expect(frame.action).toBe("send_msg");
        expect(typeof frame.echo).toBe("string");
        expect(frame.params.message_type).toBe("private");
        expect(frame.params.user_id).toBe(owner);
        expect(frame.params.message).toMatch(prefix);
      }

      async function expectScheduledNotification(prefix: RegExp) {
        await Promise.all([
          expectNotification(first, 51, prefix), expectNotification(second, 52, prefix),
          ...(milkyId === 104 ? [milky.expectMessage(54, prefix)] : []),
        ]);
        expect(milky.frames).toEqual([]);
      }

      await expectScheduledNotification(/^关机成功/u);
      const response = await fetch(new URL("/status", endpoint.replace(/^ws/u, "http")), {
        headers: { Authorization: `Bearer ${httpToken}` }, signal: AbortSignal.timeout(1_000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ok", name: "Lotus-Yunzai" });
      first.probe(42);
      second.probe(52);

      await expectScheduledNotification(/^开机成功/u);
      second.probe(42);
      expect((await second.next()).params.message).toMatch(/^Lotus-Yunzai 正在运行/u);
      // 同号 OneBot 已探测用户 42，换一个用户验证独立的 Milky 请求。
      await milky.probe(43);
      await milky.expectMessage(43, /^Lotus-Yunzai 正在运行/u);
      expect(milky.frames).toEqual([]);
      expect(unbound.frames).toEqual([]);
      expect(first.frames).toEqual([]);
      expect(second.frames).toEqual([]);

      host.kill();
      expect(await host.exited).toBe(143);
      const warnings = await stderr;
      expect(warnings).not.toContain("无效的 start_cron");
      expect(warnings).not.toContain("部分主人未收到定时开关机通知");
    } finally {
      for (const { socket } of clients) socket.close();
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
      clearTimeout(stop);
      reader.releaseLock();
    }
  } finally {
    milky.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("五段字符串定时关机和六段数组定时开机通知仅 Milky 在线账号的主人", () => exerciseScheduledPower(104), 14_000);
test("同 QQ 的 OneBot 和 Milky 同时在线时只由 OneBot 发定时开关机通知", () => exerciseScheduledPower(100), 14_000);
