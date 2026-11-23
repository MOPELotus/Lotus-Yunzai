import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createProcessReceipts } from "../lib/process-receipts.ts";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

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

function boot(root: string, managed?: { token: string; receive: (message: unknown) => void }) {
  const child = Bun.spawn([process.execPath, "app.ts"], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token, LOTUS_MANAGED_TOKEN: managed?.token },
    ...(managed && { ipc: managed.receive }),
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

  const exitHooks = () => readFile(join(root, "fixture-v3-exit"), "utf8").catch((error: NodeJS.ErrnoException) => {
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
      writeFile(join(root, "plugins/v3-exit.js"), `
        import { appendFile } from "node:fs/promises";
        export default class extends plugin {
          init() {
            const save = async reason => {
              await Bun.sleep(40);
              await appendFile("fixture-v3-exit", reason + "\\n");
            };
            const removed = () => appendFile("fixture-v3-exit", "removed\\n");
            Bot.on("exit", save).once("exit", save).on("exit", removed).off("exit", removed);
            Bot.on("online", removed);
            Bot.on("exit", () => { throw new Error("fixture listener failure"); });
          }
        }
      `),
      writeFile(join(root, "plugins/v3-exit-failed-init.js"), `
        import { appendFile } from "node:fs/promises";
        export default class extends plugin {
          init() {
            Bot.once("exit", () => appendFile("fixture-v3-exit", "failed-init\\n"));
            throw new Error("fixture init failure");
          }
        }
      `),
      writeFile(join(plugin, "index.ts"), `
        import { appendFile } from "node:fs/promises";
        export default {
          commands: { "${probe}": () => String(process.pid) },
          dispose() { return appendFile(new URL("../../fixture-disposals.txt", import.meta.url), process.pid + "\\n"); },
        };
      `),
    ]);

    disableMemberPrewarm(root);
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
    expect(await exitHooks()).toBe("");

    original.command("#重启", 51, 77);
    const restart = await expectedReply(original, { group_id: 77 }, /^开始重启/u);
    expect(await readDisposals()).toBe("");
    expect(await exitHooks()).toBe("");
    original.confirm(restart);
    const [restartedEndpoint] = await Promise.all([
      host.endpoint(), deadline(original.closed, "重启时原 OneBot 连接没有关闭。"),
    ]);
    expect(await readDisposals()).toBe(`${pid}\n`);
    expect(await exitHooks()).toBe("restart\nrestart\n");

    const other = await open(restartedEndpoint, 100);
    expect(await processId(other)).toBe(pid);
    const resumed = await open(restartedEndpoint, 99);
    resumed.confirm(await expectedReply(resumed, { group_id: 77 }, /^重启成功，用时/u));

    resumed.command("#停机", 51);
    resumed.confirm(await expectedReply(resumed, { user_id: 51 }, /^开始停止/u));
    expect(await deadline(host.child.exited, "停机后宿主没有退出。")).toBe(0);
    expect(await readDisposals()).toBe(`${pid}\n${pid}\n`);
    expect(await exitHooks()).toBe("restart\nrestart\nexit\nexit\n");
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
    expect(await exitHooks()).toBe("restart\nrestart\nexit\nexit\nexit\nexit\n");
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

    disableMemberPrewarm(root);
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

test.each([true, false])("V3 退出回调持有活动句柄时仍完成清理和停机（超时：%s）", async (hangs) => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-hung-exit-"));
  let host: ReturnType<typeof boot> | undefined;
  let client: Gateway | undefined;
  try {
    await copyHost(root);
    disableMemberPrewarm(root);
    await Promise.all([
      writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51"]\n'),
      writeFile(join(root, "plugins/hung-exit.js"), `
        export default class extends plugin {
          init() {
            Bot.once("exit", () => {
              setInterval(() => {}, 1000);
              ${hangs ? "return new Promise(() => {});" : ""}
            });
            this.addCleanup(() => Bun.write("fixture-cleanup", "done"));
          }
        }
      `),
    ]);
    host = boot(root);
    client = gateway(await host.endpoint(), 99);
    await deadline(client.opened, "退出回调测试网关连接超时。");
    client.command("#停机", 51);
    client.confirm(await expectedReply(client, { user_id: 51 }, /^开始停止/u));
    expect(await host.child.exited).toBe(0);
    expect((await host.stderr).includes("等待 V3 退出回调超时")).toBe(hangs);
    expect(await Bun.file(join(root, "fixture-cleanup")).text()).toBe("done");
  } finally {
    client?.socket.close();
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test.each([false, true])("旧插件的无钩子长计时器在完成清理后不会挂住进程（托管重启：%s）", async (restart) => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-referenced-timer-"));
  const token = crypto.randomUUID();
  const ipcReady = Promise.withResolvers<void>();
  const ipcRestart = Promise.withResolvers<void>();
  const marker = join(root, "native-cleaned");
  let host: ReturnType<typeof boot> | undefined;
  try {
    await copyHost(root);
    disableMemberPrewarm(root);
    const module = join(root, "plugins", "native-fixture");
    await mkdir(module);
    await Promise.all([
      writeFile(join(root, "config/config/other.yaml"), 'master: ["stdin:stdin"]\n'),
      writeFile(join(root, "plugins", "untamed-timeout.js"), `
        export default class extends plugin {
          constructor() {
            super();
            setTimeout(() => { throw new Error("fixture timeout fired"); }, 600000);
          }
        }
      `),
      writeFile(join(module, "package.json"), JSON.stringify({
        name: "native-fixture", lotusYunzai: { entry: "./index.ts" },
      })),
      writeFile(join(module, "index.ts"), `
        export default {
          commands: {},
          async dispose() {
            await Bun.sleep(40);
            await Bun.write("native-cleaned", "done");
          },
        };
      `),
    ]);
    host = boot(root, restart ? { token, receive(message) {
      if (!message || typeof message !== "object" || !("token" in message) || message.token !== token ||
          !("type" in message)) return;
      if (message.type === "lotus-ready") ipcReady.resolve();
      if (message.type === "lotus-restart") ipcRestart.resolve();
    } } : undefined);
    await host.output(/^Lotus-Yunzai 已启动/mu);
    if (restart) {
      await deadline(ipcReady.promise, "宿主未报告就绪。");
      host.command("#重启");
      await host.output(/^开始重启/mu);
      await deadline(ipcRestart.promise, "托管重启 IPC 未送达。");
      expect(await readFile(marker, "utf8")).toBe("done");
    } else {
      host.child.kill("SIGTERM");
    }

    expect(await deadline(host.child.exited, "旧插件的活动计时器阻止退出。")).toBe(restart ? 0 : 143);
    expect(await readFile(marker, "utf8")).toBe("done");
    if (restart) {
      const receipts = createProcessReceipts(pathToFileURL(root + "/"));
      expect(await receipts.take()).toMatchObject({ kind: "restart", target: { type: "terminal" } });
    }
    expect(await host.stderr).not.toContain("无法重新启动宿主");
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
