import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "runtime-diagnostics-fixture";
const accountTitle = "账号在线时长";
const pluginTitle = "插件加载用时";

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(description)), 2_500);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function oneBotEndpoint(stdout: ReadableStream<Uint8Array>) {
  let output = "";
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`诊断测试宿主未启动。\n${output}`);
      output += decoder.decode(chunk.value, { stream: true });
      const match = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output);
      if (match) return match[0];
    }
  } finally {
    reader.releaseLock();
  }
}

function gateway(url: string, botId?: number) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal" };
  if (botId !== undefined) headers["X-Self-ID"] = String(botId);
  const socket = new BunWebSocket(url, { headers });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));

  let messageId = 0;
  return {
    socket, opened, closed,
    async command(message: string, userId: number) {
      const response = new Promise<{
        action: string;
        params: { group_id: number; message: string };
      }>((resolve) => {
        socket.addEventListener("message", ({ data }) => resolve(JSON.parse(data)), { once: true });
      });
      socket.send(JSON.stringify({
        post_type: "message", message_type: "group", sub_type: "normal",
        self_id: botId, user_id: userId, group_id: 77, message_id: ++messageId,
        sender: { role: "owner" }, message,
      }));
      const frame = await deadline(response, `机器人 ${botId} 未回复 ${message}。`);
      expect(frame).toMatchObject({ action: "send_msg", params: { group_id: 77 } });
      return frame.params.message;
    },
  };
}

async function fixturePlugin(root: string, name: string, source: string) {
  const directory = join(root, "plugins", name);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, "package.json"), JSON.stringify({
      name, type: "module", lotusYunzai: { entry: "./index.ts" },
    })),
    writeFile(join(directory, "index.ts"), source),
  ]);
}

function expectRuntimeSummary(reply: string, botId: number) {
  const [, summary] = reply.split(`\n\n${accountTitle}\n`);
  expect(summary).toBeDefined();
  const [accounts, plugins] = summary!.split(`\n\n${pluginTitle}\n`);
  expect(accounts).toMatch(new RegExp(`^${botId}　\\d+ 秒$`, "u"));
  expect(plugins).toMatch(/^system　\d+ ms$/mu);
  const slowPlugin = /^diagnostics-slow　(\d+) ms$/mu.exec(plugins!);
  expect(Number(slowPlugin?.[1])).toBeGreaterThanOrEqual(25);
  expect(plugins).not.toContain("diagnostics-failed");
}

test("OneBot 运行诊断按机器人隔离主人视图并记录成功插件的加载用时", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-runtime-diagnostics-"));
  const clients: ReturnType<typeof gateway>[] = [];
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51", "100:52"]\n'),
      fixturePlugin(root, "diagnostics-slow", `
        await Bun.sleep(30);
        export default { commands: { "#诊断夹具": () => "诊断夹具已加载" } };
      `),
      fixturePlugin(root, "diagnostics-failed", 'throw new Error("诊断夹具加载失败");'),
    ]);
    disableMemberPrewarm(root);
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    const stderr = new Response(host.stderr).text();
    const url = await deadline(oneBotEndpoint(host.stdout), "诊断测试宿主启动超时。");
    const connect = async (botId?: number) => {
      const client = gateway(url, botId);
      clients.push(client);
      await deadline(client.opened, "诊断测试网关连接超时。");
      return client;
    };

    const first = await connect(99);
    const second = await connect(100);
    expect(await first.command("#诊断夹具", 42)).toBe("诊断夹具已加载");

    const regularDiagnostics = await first.command("#诊断", 42);
    const basicFields = regularDiagnostics.split("\n").map((line) => line.split("　")[0]);
    expect(basicFields).toEqual(["Lotus-Yunzai 运行诊断", "运行环境", "运行时间", "常驻内存", "JS 堆内存"]);
    expect(await first.command("#诊断", 52)).not.toContain(accountTitle);

    const firstReport = await first.command("#诊断", 51);
    expect(firstReport.split(`\n\n${accountTitle}\n`)[0]?.split("\n").map((line) => line.split("　")[0]))
      .toEqual(basicFields);
    expectRuntimeSummary(firstReport, 99);
    expectRuntimeSummary(await second.command("#诊断", 52), 100);

    const regularStatus = await first.command("#状态", 42);
    expect(regularStatus).toMatch(/^Lotus-Yunzai 正在运行（Bun [^\n]+）$/u);
    const masterStatus = await first.command("#状态", 51);
    expect(masterStatus.split("\n")[0]).toBe(regularStatus);
    expectRuntimeSummary(masterStatus, 99);

    const unbound = await connect();
    unbound.socket.close();
    await deadline(unbound.closed, "未绑定网关关闭超时。");
    const replacement = await connect(99);
    first.socket.close();
    await deadline(first.closed, "被替换网关关闭超时。");
    expectRuntimeSummary(await replacement.command("#诊断", 51), 99);
    expectRuntimeSummary(await second.command("#诊断", 52), 100);

    host.kill();
    expect(await deadline(host.exited, "诊断测试宿主退出超时。")).toBe(143);
    const failedLogs = (await stderr).split("\n").filter(line => line.includes("[diagnostics-failed]"));
    expect(failedLogs).toHaveLength(1);
    expect(failedLogs[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\[WARN\] \[Plugin\] 加载插件错误 \[diagnostics-failed\] 诊断夹具加载失败$/u);
  } finally {
    for (const { socket } of clients) socket.close();
    if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await host?.exited;
    await rm(root, { recursive: true, force: true });
  }
});
