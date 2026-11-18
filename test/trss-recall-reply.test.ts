import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

type Incoming = string | { type: string; data: Record<string, string | number> }[];
interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: Readonly<Record<string, unknown>>;
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 2_500);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function connect(endpoint: string, botId?: number) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const headers: Record<string, string> = {
    Authorization: "Bearer recall-reply-fixture", "X-Client-Role": "Universal",
  };
  if (botId !== undefined) headers["X-Self-ID"] = String(botId);
  const socket = new BunWebSocket(endpoint, { headers });
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
  const frames: Frame[] = [];
  let available = Promise.withResolvers<void>();
  socket.addEventListener("message", ({ data }) => {
    frames.push(JSON.parse(data));
    available.resolve();
  });
  try {
    await deadline(new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    }), "模拟网关连接超时。");
  } catch (error) {
    socket.close();
    throw error;
  }

  function send(value: object) {
    socket.send(JSON.stringify({ self_id: botId ?? 99, ...value }));
  }

  async function take(action: string, params: object = {}) {
    if (!frames.length) await deadline(available.promise, `未收到 ${action}。`);
    const frame = frames.shift()!;
    if (!frames.length) available = Promise.withResolvers<void>();
    expect(frame).toMatchObject({ action, params });
    return frame;
  }

  return {
    send,
    take,
    closed,
    close: () => socket.close(),
    assertNoPendingFrames: () => expect(frames).toEqual([]),
    message(message: Incoming, message_id: number, options: object = {}) {
      send({
        post_type: "message", message_type: "group", sub_type: "normal", group_id: 77,
        user_id: 51, message_id, message, ...options,
      });
    },
    async deletion(message_id: number) {
      const frame = await take("delete_msg", { message_id });
      expect(typeof frame.echo).toBe("string");
      return frame;
    },
    receipt(frame: Frame, status = "ok", retcode = 0) {
      send({ echo: frame.echo, status, retcode });
    },
    async status() {
      send({ post_type: "message", message_type: "private", sub_type: "friend", user_id: 42, message: "#状态" });
      await take("send_msg", {
        message_type: "private", user_id: 42, message: expect.stringContaining("Lotus-Yunzai 正在运行"),
      });
    },
  };
}

type Gateway = Awaited<ReturnType<typeof connect>>;

async function endpointOf(host: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const reader = host.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) throw new Error("测试宿主未启动 OneBot 入口。");
      output += decoder.decode(part.value, { stream: true });
      const endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      if (endpoint) return endpoint;
    }
  } finally {
    reader.releaseLock();
  }
}

async function withHost(run: (open: (botId?: number) => Promise<Gateway>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-recall-reply-"));
  const gateways: Gateway[] = [];
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51", "100:52"]\n');
    await writeFile(join(root, "plugins/legacy-recall.js"), `
      export default class extends plugin {
        constructor() { super({ event: "message.group", rule: [{ reg: /^#撤回$/, fnc: "custom" }] }); }
        custom(e) { return e.group_id === 78 && e.reply("旧插件已处理撤回"); }
      }
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: "recall-reply-fixture" },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const endpoint = await deadline(endpointOf(host), "测试宿主启动超时。");
      await run(async (botId) => {
        const gateway = await connect(endpoint, botId);
        gateways.push(gateway);
        return gateway;
      });
      host.kill();
      await deadline(host.exited, "测试宿主退出超时。");
      for (const gateway of gateways) {
        await deadline(gateway.closed, "测试网关断开超时。");
        gateway.assertNoPendingFrames();
      }
      expect(await stderr).not.toContain("处理 OneBot 事件失败");
    } finally {
      for (const gateway of gateways) gateway.close();
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function quoted(command: string, id: string | number): Incoming {
  return [{ type: "reply", data: { id } }, { type: "text", data: { text: command } }];
}

test("只有当前已绑定机器人的主人可撤回命令和引用，成功不发聊天回复", () => withHost(async (open) => {
  const gateway = await open(99);
  const otherBot = await open(100);
  const unbound = await open();

  gateway.message(quoted("#撤回", -703), -702, { user_id: 42, isMaster: true, sender: { role: "owner" } });
  otherBot.message(quoted("#撤回", -703), -702);
  otherBot.message(quoted("#撤回", -703), -702, { self_id: 99 });
  unbound.message(quoted("#撤回", -703), -702);
  await gateway.status();
  await otherBot.status();
  await unbound.status();

  gateway.message(quoted("#撤回", 705), 704, { group_id: 78 });
  await gateway.take("send_msg", { group_id: 78, message: "旧插件已处理撤回" });
  await gateway.status();

  gateway.message(quoted("#撤回", "-705"), -704);
  const command = await gateway.deletion(-704);
  const target = await gateway.deletion(-705);
  expect(command.echo).not.toBe(target.echo);
  gateway.receipt(target);
  gateway.receipt(command);
  await gateway.status();

  gateway.message("[CQ:reply,id=-707] 撤回", 706, { message_type: "private", sub_type: "friend" });
  const privateCommand = await gateway.deletion(706);
  const privateTarget = await gateway.deletion(-707);
  gateway.receipt(privateCommand);
  gateway.receipt(privateTarget);
  await gateway.status();

  gateway.message("#撤回", 708);
  gateway.receipt(await gateway.deletion(708));
  await gateway.status();

  otherBot.message(quoted("撤回", "-709"), -709, { user_id: 52 });
  otherBot.receipt(await otherBot.deletion(-709));
  await otherBot.status();
}), 9_000);

test("撤回动作各自等待关联回执，明确失败不阻止另一条，未知结果有提示", () => withHost(async (open) => {
  const gateway = await open(99);
  gateway.message(quoted("#撤回", -802), -801);
  const rejected = await gateway.deletion(-801);
  const confirmed = await gateway.deletion(-802);
  gateway.receipt(rejected, "failed", 1403);
  gateway.send({ echo: "unrelated-echo", status: "ok", retcode: 0 });
  await gateway.status();
  gateway.receipt(confirmed);
  const failure = await gateway.take("send_msg", { message_type: "group", group_id: 77 });
  expect(failure.params.message).toContain("未能撤回");
  expect(failure.params.message).not.toContain("结果未确认");

  gateway.message("[CQ:reply,id=-804] 撤回", -803);
  const completed = await gateway.deletion(-803);
  const unknown = await gateway.deletion(-804);
  gateway.receipt(unknown, "async", 1);
  await gateway.status();
  gateway.receipt(completed);
  await gateway.take("send_msg", {
    message_type: "group", group_id: 77, message: expect.stringContaining("结果未确认"),
  });
  await gateway.status();
}), 9_000);
