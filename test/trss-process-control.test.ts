import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const token = "process-control-onebot-fixture";
const probe = "#测试进程号";

interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: { readonly message: string; readonly group_id?: number; readonly user_id?: number };
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 3_500);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function boot(root: string) {
  const child = Bun.spawn([process.execPath, "app.ts"], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
  });
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  const decoder = new TextDecoder();
  let unread = "";

  async function nextOutput(pattern: RegExp) {
    while (true) {
      const match = pattern.exec(unread);
      if (match) {
        unread = unread.slice(match.index + match[0].length);
        return match;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`进程管理测试宿主未输出 ${pattern.source}。\n${unread}\n${await stderr}`);
      unread += decoder.decode(chunk.value, { stream: true });
    }
  }

  return {
    child,
    stderr,
    async endpoint() {
      const [endpoint] = await deadline(nextOutput(/ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u), "未读到下一次 OneBot 监听地址。");
      return endpoint;
    },
    output: (pattern: RegExp) => deadline(nextOutput(pattern), `未读到 ${pattern.source}。`),
    command: (line: string) => {
      child.stdin.write(`${line}\n`);
      child.stdin.flush();
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
      child.stdin.end();
      await reader.cancel();
      reader.releaseLock();
    },
  };
}

function gateway(endpoint: string, botId?: number) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal" };
  if (botId !== undefined) headers["X-Self-ID"] = String(botId);
  const socket = new BunWebSocket(endpoint, { headers });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
  const frames: Frame[] = [];
  let ready = Promise.withResolvers<void>();
  socket.addEventListener("message", ({ data }) => {
    frames.push(JSON.parse(data));
    ready.resolve();
  });

  let messageId = 0;
  return {
    socket, opened, closed, frames,
    async next() {
      if (!frames.length) await deadline(ready.promise, "未收到进程管理测试 OneBot 消息。");
      const frame = frames.shift()!;
      if (!frames.length) ready = Promise.withResolvers<void>();
      return frame;
    },
    command(message: string, userId: number, groupId?: number, role = "member") {
      socket.send(JSON.stringify({
        post_type: "message", message_type: groupId ? "group" : "private", sub_type: groupId ? "normal" : "friend",
        self_id: botId ?? 99, user_id: userId, group_id: groupId, message_id: ++messageId, message, sender: { role },
      }));
    },
    confirm(frame: Frame) {
      expect(typeof frame.echo).toBe("string");
      socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 7 } }));
    },
  };
}

type Gateway = ReturnType<typeof gateway>;

async function processId(client: Gateway) {
  client.command(probe, 42);
  const frame = await client.next();
  expect(frame).toMatchObject({ action: "send_msg", params: { user_id: 42 } });
  return Number(frame.params.message);
}

async function expectedReply(client: Gateway, recipient: { user_id: number } | { group_id: number }, prefix: RegExp) {
  const frame = await client.next();
  expect(frame.params).toMatchObject(recipient);
  if ("group_id" in recipient) {
    expect(frame.action).toMatch(/^send_(?:group_)?msg$/u);
  } else {
    expect(frame.action).toBe("send_msg");
  }
  expect(frame.params.message).toMatch(prefix);
  return frame;
}

test.skipIf(process.platform !== "linux")("进程管理在同一 PID 重启并向原 OneBot 会话回执，停止后可独立启动", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-process-control-"));
  const clients: Gateway[] = [];
  const hosts: ReturnType<typeof boot>[] = [];
  const disposals = join(root, "fixture-disposals.txt");
  const readDisposals = () => readFile(disposals, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });

  try {
    await copyHost(root);
    const plugin = join(root, "plugins/process-fixture");
    await Promise.all([mkdir(plugin), mkdir(join(root, "config/config"), { recursive: true })]);
    await Promise.all([
      writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51", "100:51", "100:52"]\n'),
      writeFile(join(plugin, "package.json"), JSON.stringify({
        name: "process-fixture", type: "module", lotusYunzai: { entry: "./index.ts" },
      })),
      writeFile(join(plugin, "index.ts"), `
        import { appendFile } from "node:fs/promises";
        export default {
          commands: { "${probe}": () => String(process.pid) },
          dispose() { return appendFile(new URL("../../fixture-disposals.txt", import.meta.url), process.pid + "\\n"); },
        };
      `),
    ]);

    const open = async (endpoint: string, botId?: number) => {
      const client = gateway(endpoint, botId);
      clients.push(client);
      await deadline(client.opened, "进程管理测试网关连接超时。");
      return client;
    };
    const host = boot(root);
    hosts.push(host);
    const initialEndpoint = await host.endpoint();
    const original = await open(initialEndpoint, 99);
    const unbound = await open(initialEndpoint);
    const pid = host.child.pid;
    expect(await processId(original)).toBe(pid);

    original.command("#重启", 42, 77, "owner");
    await expectedReply(original, { group_id: 77 }, /^暂无权限/u);
    unbound.command("#重启", 51);
    expect(await processId(unbound)).toBe(pid);
    expect(await readDisposals()).toBe("");

    original.command("#重启", 51, 77);
    const restart = await expectedReply(original, { group_id: 77 }, /^开始重启/u);
    expect(await readDisposals()).toBe("");
    original.confirm(restart);
    const [restartedEndpoint] = await Promise.all([
      host.endpoint(), deadline(original.closed, "重启时原 OneBot 连接没有关闭。"),
    ]);
    expect(await readDisposals()).toBe(`${pid}\n`);

    const other = await open(restartedEndpoint, 100);
    expect(await processId(other)).toBe(pid);
    const resumed = await open(restartedEndpoint, 99);
    resumed.confirm(await expectedReply(resumed, { group_id: 77 }, /^重启成功，用时/u));

    resumed.command("#停机", 51);
    resumed.confirm(await expectedReply(resumed, { user_id: 51 }, /^开始停止/u));
    expect(await deadline(host.child.exited, "停机后宿主没有退出。")).toBe(0);
    expect(await readDisposals()).toBe(`${pid}\n${pid}\n`);
    expect(other.frames).toEqual([]);

    const manual = boot(root);
    hosts.push(manual);
    const manualEndpoint = await manual.endpoint();
    const otherAfterStop = await open(manualEndpoint, 100);
    expect(await processId(otherAfterStop)).toBe(manual.child.pid);
    const afterStop = await open(manualEndpoint, 99);
    afterStop.confirm(await expectedReply(afterStop, { user_id: 51 }, /^开机成功，距离上次停止/u));
    afterStop.command("#停止", 51);
    afterStop.confirm(await expectedReply(afterStop, { user_id: 51 }, /^开始停止/u));
    expect(await deadline(manual.child.exited, "停止后宿主没有退出。")).toBe(0);
    expect(await readDisposals()).toBe(`${pid}\n${pid}\n${manual.child.pid}\n`);
    expect(otherAfterStop.frames).toEqual([]);
    for (const run of hosts) expect(await run.stderr).not.toContain("处理 OneBot 事件失败");
  } finally {
    for (const { socket } of clients) socket.close();
    await Promise.all(hosts.map((host) => host.close()));
    await rm(root, { recursive: true, force: true });
  }
}, 16_000);

test.skipIf(process.platform !== "linux")("授权 stdin 重启保留 PID 和终端命令输入", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-process-terminal-"));
  let host: ReturnType<typeof boot> | undefined;
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "config/config/other.yaml"), 'master: ["stdin:stdin"]\n'),
      writeFile(join(root, "plugins/terminal-process-fixture.js"), `
        console.log("fixture-terminal-pid " + process.pid);
        export default class extends plugin {};
      `),
    ]);

    host = boot(root);
    const pidLine = /^fixture-terminal-pid (\d+)\n/mu;
    expect(Number((await host.output(pidLine))[1])).toBe(host.child.pid);
    await host.endpoint();
    host.command("#重启");
    await host.output(/^开始重启[^\n]*\n/mu);
    expect(Number((await host.output(pidLine))[1])).toBe(host.child.pid);
    await host.endpoint();
    await host.output(/^重启成功，用时[^\n]*\n/mu);

    host.command("#状态");
    await host.output(/^Lotus-Yunzai 正在运行[^\n]*\n/mu);
    host.command("#停机");
    await host.output(/^开始停止[^\n]*\n/mu);
    expect(await deadline(host.child.exited, "终端停机后宿主没有退出。")).toBe(0);
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 16_000);
