import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const oneBotToken = "scheduled-power-onebot-fixture";
const httpToken = "scheduled-power-http-fixture";

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

test("五段字符串定时关机和六段数组定时开机只通知当前在线机器人的主人", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-scheduled-power-"));
  const clients: ReturnType<typeof connect>[] = [];
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51", "100:52", "101:53"]\n'),
      writeFile(join(root, "config/config/bot.yaml"), [
        'stop_cron: "0 13 * * *"',
        'start_cron: ["2 0 13 * * *", "15 13 * * *"]',
        "",
      ].join("\n")),
      // Move this child close to a minute boundary. The actual scheduler and its timers still run.
      writeFile(join(root, "fixture-clock.js"), `
        const DateConstructor = Date;
        const origin = DateConstructor.parse("2032-04-14T12:59:56.000Z") - performance.now();
        const now = () => Math.floor(origin + performance.now());
        globalThis.Date = new Proxy(DateConstructor, {
          get: (target, key, receiver) => key === "now" ? now : Reflect.get(target, key, receiver),
          construct: (target, args, constructor) => Reflect.construct(target, args.length ? args : [now()], constructor),
          apply: () => new DateConstructor(now()).toString(),
        });
      `),
    ]);

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

      async function expectNotification(client: typeof first, owner: number, prefix: RegExp) {
        const frame = await client.next();
        expect(frame.action).toBe("send_msg");
        expect(typeof frame.echo).toBe("string");
        expect(frame.params.message_type).toBe("private");
        expect(frame.params.user_id).toBe(owner);
        expect(frame.params.message).toMatch(prefix);
      }

      await Promise.all([expectNotification(first, 51, /^关机成功/u), expectNotification(second, 52, /^关机成功/u)]);
      const response = await fetch(new URL("/status", endpoint.replace(/^ws/u, "http")), {
        headers: { Authorization: `Bearer ${httpToken}` }, signal: AbortSignal.timeout(1_000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ok", name: "Lotus-Yunzai" });
      first.probe(42);
      second.probe(52);

      await Promise.all([expectNotification(first, 51, /^开机成功/u), expectNotification(second, 52, /^开机成功/u)]);
      second.probe(42);
      expect((await second.next()).params.message).toMatch(/^Lotus-Yunzai 正在运行/u);
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
    await rm(root, { recursive: true, force: true });
  }
}, 14_000);
