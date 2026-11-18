import { RedisClient } from "bun";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createProcessReceipts } from "../lib/process-receipts.ts";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const valkeyServer = Bun.which("valkey-server");
const token = "online-notice-fixture";
const defaultCooldown = 1440 * 60;

interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: { readonly user_id?: number; readonly group_id?: number; readonly message?: string };
}

function timeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, message: string): Promise<T> {
  const end = performance.now() + 3_000;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(10);
  } while (performance.now() < end);
  throw new Error(message);
}

async function matchOutput(stdout: ReadableStream<Uint8Array>, pattern: RegExp): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const match = pattern.exec(output);
      if (match) return match[0];
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`上线通知夹具未启动。\n${output}`);
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function gateway(url: string, botId?: number) {
  const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal" };
  if (botId !== undefined) headers["X-Self-ID"] = String(botId);
  const socket = new Socket(url, { headers });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const frames: Frame[] = [];
  let messageId = 0;
  function confirm(frame: Frame) {
    if (frame.echo) socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 7 } }));
  }
  socket.addEventListener("message", ({ data }) => {
    const frame: Frame = JSON.parse(data);
    frames.push(frame);
    if (!frame.params.message?.startsWith("重启成功")) confirm(frame);
  });
  return {
    socket, opened, frames, confirm,
    async status(selfId = botId) {
      socket.send(JSON.stringify({
        post_type: "message", message_type: "private", sub_type: "friend", self_id: selfId,
        user_id: 42, message_id: ++messageId, message: "#状态",
      }));
      const frame = await waitFor(() => frames.shift(), "未收到上线通知夹具的状态回复。");
      expect(frame).toMatchObject({ action: "send_msg", params: { user_id: 42 } });
      expect(frame.params.message).toMatch(/^Lotus-Yunzai 正在运行/u);
    },
  };
}

type Gateway = ReturnType<typeof gateway>;

async function expectWelcome(clients: readonly Gateway[], owner: number) {
  const received = await waitFor(() => clients.find(({ frames }) => frames.length)?.frames.shift(), "未收到主人私聊上线通知。");
  expect(received).toMatchObject({ action: "send_msg", params: { message_type: "private", user_id: owner } });
  expect(received.params.group_id).toBeUndefined();
  expect(received.params.message).toMatch(/欢迎使用.*Lotus-Yunzai v1\.2\.3/u);
}

test.skipIf(!valkeyServer)("TRSS 上线通知按绑定机器人和 Valkey 冷却跨进程去重", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-online-notice-"));
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  const password = crypto.randomUUID();
  const url = `redis://:${password}@127.0.0.1:${port}`;
  const valkey = Bun.spawn([
    valkeyServer!, "--bind", "127.0.0.1", "--port", String(port), "--requirepass", password,
    "--save", "", "--appendonly", "no", "--dir", root,
  ], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const redis = new RedisClient(url, { autoReconnect: false });
  const key = (bot: number) => `Yz:loginMsg:${bot}`;

  async function withHost(run: (open: (botId?: number) => Promise<Gateway>) => Promise<void>) {
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token, LOTUS_VALKEY_URL: url },
    });
    const stderr = new Response(host.stderr).text();
    const clients: Gateway[] = [];
    try {
      const endpoint = await timeout(matchOutput(host.stdout, /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u), "OneBot 夹具启动超时。");
      await run(async (botId) => {
        const client = gateway(endpoint, botId);
        clients.push(client);
        await timeout(client.opened, "模拟 OneBot 未连接。");
        return client;
      });
      host.kill("SIGTERM");
      expect(await timeout(host.exited, "上线通知夹具结束超时。")).toBe(143);
      expect(await stderr).not.toContain("处理 OneBot 事件失败");
    } finally {
      for (const { socket } of clients) socket.close();
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
    }
  }

  async function expectCooldown(botId: number) {
    expect(await redis.get(key(botId))).toBe("1");
    const ttl = Number(await redis.send("TTL", [key(botId)]));
    expect(ttl).toBeGreaterThan(defaultCooldown - 30);
    expect(ttl).toBeLessThanOrEqual(defaultCooldown);
  }

  try {
    await timeout(matchOutput(valkey.stdout, /Ready to accept connections/u), "隔离 Valkey 启动超时。");
    await redis.connect();
    await copyHost(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "online-notice-fixture", type: "module", version: "1.2.3" }));
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/other.yaml"), 'master: ["99:51", "100:52", "101:53"]\nmasterQQ: [54]\n');
    await redis.send("SET", [key(99), "legacy-cooldown", "EX", "45"]);

    await withHost(async (open) => {
      const legacy = await open(99);
      const unbound = await open();
      const competing = await Promise.all([open(100), open(100)]);
      await expectWelcome(competing, 52);
      await Promise.all([legacy.status(), unbound.status(101)]);
      await expectCooldown(100);
      expect(await redis.get(key(99))).toBe("legacy-cooldown");
      expect(await redis.get(key(101))).toBeNull();
      expect(Number(await redis.send("TTL", [key(99)]))).toBeLessThanOrEqual(45);
      await Bun.sleep(100);
      for (const client of [legacy, unbound, ...competing]) expect(client.frames).toEqual([]);
    });

    await withHost(async (open) => {
      const legacy = await open(99);
      const duplicate = await open(100);
      await Promise.all([legacy.status(), duplicate.status()]);
      await expectCooldown(100);
      expect(await redis.get(key(99))).toBe("legacy-cooldown");

      expect(await redis.send("PEXPIRE", [key(99), "60"])).toBe(1);
      await waitFor(async () => await redis.get(key(99)) === null ? true : undefined, "旧上线冷却键未实际过期。");
      await createProcessReceipts(pathToFileURL(root + "/")).save({
        kind: "restart", at: Date.now(), target: { type: "private", botId: 99, id: 51 },
      });
      const fresh = await open(99);
      const receipt = await waitFor(() => fresh.frames.shift(), "重连未收到先前进程回执。");
      expect(receipt).toMatchObject({ action: "send_msg", params: { message_type: "private", user_id: 51 } });
      expect(receipt.params.message).toMatch(/^重启成功，用时/u);
      expect(typeof receipt.echo).toBe("string");
      await Bun.sleep(50);
      expect(fresh.frames).toEqual([]);
      expect(await redis.get(key(99))).toBeNull();
      fresh.confirm(receipt);
      await expectWelcome([fresh], 51);
      await expectCooldown(99);
      for (const client of [legacy, duplicate, fresh]) expect(client.frames).toEqual([]);
    });

    await writeFile(join(root, "config/bot.yaml"), "online_msg_exp: 0\n");
    await withHost(async (open) => {
      const disabled = await open(101);
      await disabled.status();
      await Bun.sleep(100);
      expect(disabled.frames).toEqual([]);
      expect(await redis.get(key(101))).toBeNull();
    });
  } finally {
    redis.close();
    if (valkey.exitCode === null && valkey.signalCode === null) valkey.kill("SIGTERM");
    await valkey.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
