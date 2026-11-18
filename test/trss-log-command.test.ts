import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const token = "log-command-fixture";
const startupMarker = "fixture-plugin-startup-marker";
const terminalMarker = "fixture-terminal-log-marker";
const unsafeMarkers = ["fixture-cookie-value", "fixture-authorization-value", "fixture-authkey-value"];

interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: {
    user_id?: number;
    group_id?: number;
    message?: string;
    messages?: readonly { type: string; data: { uin: string; content: readonly { data: { text: string } }[] } }[];
  };
}

async function until<T>(read: () => T | undefined | Promise<T | undefined>, error: string): Promise<T> {
  const end = performance.now() + 2_000;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(5);
  } while (performance.now() < end);
  throw new Error(error);
}

function connect(url: string, botId?: number) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal" };
  if (botId !== undefined) headers["X-Self-ID"] = String(botId);
  const socket = new BunWebSocket(url, { headers });
  const frames: Frame[] = [];
  socket.addEventListener("message", ({ data }) => frames.push(JSON.parse(data)));
  let messageId = 0;

  return {
    socket,
    frames,
    command(message: string, userId: number, groupId?: number) {
      socket.send(JSON.stringify({
        post_type: "message", message_type: groupId ? "group" : "private", sub_type: groupId ? "normal" : "friend",
        self_id: botId ?? 99, user_id: userId, group_id: groupId, message_id: ++messageId,
        sender: { role: "owner" }, message,
      }));
    },
    next: () => until(() => frames.shift(), "没有收到日志测试 OneBot 动作。"),
    confirm(frame: Frame) {
      socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 54321 } }));
    },
  };
}

test("日志指令只向授权终端和已绑定机器人的私聊主人发送脱敏内容", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-log-command-"));
  const clients: ReturnType<typeof connect>[] = [];
  let host: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51", "stdin:stdin"]\n'),
      writeFile(join(root, "plugins/log-fixture.js"), `throw new Error(${JSON.stringify(startupMarker)});`),
      writeFile(join(root, "plugins/log-error-fixture.js"), `
        console.error("fixture-new-error token=fixture-local-secret");
        export default class extends plugin {}
      `),
    ]);
    const processHost = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, TZ: "UTC", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    host = processHost;
    timer = setTimeout(() => processHost.kill("SIGKILL"), 7_000);
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    const stderr = new Response(host.stderr).text();
    let stdout = "";
    async function readUntil(pattern: RegExp) {
      while (true) {
        const match = pattern.exec(stdout);
        if (match) return match[0];
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`日志测试宿主未输出 ${pattern.source}。\n${stdout}\n${await stderr}`);
        stdout += decoder.decode(chunk.value, { stream: true });
      }
    }

    try {
      const endpoint = await readUntil(/ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u);
      const day = new Date().toISOString().slice(0, 10);
      const runtime = join(root, "logs", `command.${day}.log`);
      const readyLog = await until(async () => {
        const content = await readFile(runtime, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return "";
        });
        return content.includes("Lotus-Yunzai 已启动") ? content : undefined;
      }, "宿主未创建当日运行日志。");
      expect(readyLog).toContain(startupMarker);
      expect(readyLog).toContain("fixture-new-error token=[已隐藏]");
      const errorLog = await readFile(join(root, "logs/error.log"), "utf8");
      expect(errorLog).toContain("fixture-new-error token=[已隐藏]");
      expect(errorLog).not.toContain("fixture-local-secret");

      await Promise.all([
        appendFile(runtime, [
          "fixture-query-key oldest line",
          `fixture-query-key Cookie: ${unsafeMarkers[0]}`,
          `fixture-query-key Authorization: Bearer ${unsafeMarkers[1]}`,
          `fixture-query-key newest AuthKey=${unsafeMarkers[2]}`,
          terminalMarker,
          "",
        ].join("\n")),
        writeFile(join(root, "logs/error.log"), "fixture-error-log-marker\n"),
      ]);

      const open = async (botId?: number) => {
        const client = connect(endpoint, botId);
        clients.push(client);
        await until(() => client.socket.readyState === WebSocket.OPEN ? true : undefined, "日志测试网关连接超时。");
        return client;
      };
      const bot = await open(99);
      const unbound = await open();

      for (const [client, userId, groupId] of [[bot, 42], [bot, 51, 77], [unbound, 51]] as const) {
        client.command("#日志 fixture-query-key", userId, groupId);
        client.command("#帮助", userId, groupId);
        const expectedTarget = groupId ? { group_id: groupId } : { user_id: userId };
        expect(await client.next()).toMatchObject({
          action: "send_msg", params: { ...expectedTarget, message: expect.stringContaining("Lotus-Yunzai 系统指令") },
        });
      }

      async function forwarded(command: string) {
        bot.command(command, 51);
        const frame = await bot.next();
        expect(frame).toMatchObject({
          action: "send_private_forward_msg", params: { user_id: 51 },
        });
        expect(typeof frame.echo).toBe("string");
        expect(frame.params.messages?.[0]).toMatchObject({ type: "node", data: { uin: "99" } });
        bot.confirm(frame);
        return frame.params.messages?.flatMap(({ data }) => data.content.map((segment) => segment.data.text)).join("\n");
      }

      expect(await forwarded("#日志")).toContain(startupMarker);
      const limited = await forwarded("#日志 1 fixture-query-key");
      expect(limited).toBe("最近 1 条运行日志\nfixture-query-key newest AuthKey=[已隐藏]");
      const filtered = await forwarded("#运行日志 fixture-query-key");
      expect(filtered).toContain("fixture-query-key oldest line");
      expect(filtered).toContain("Cookie: [已隐藏]");
      expect(filtered).toContain("Authorization: [已隐藏]");
      expect(filtered).not.toContain(terminalMarker);
      for (const secret of unsafeMarkers) expect(filtered).not.toContain(secret);
      expect(await forwarded("#错误日志")).toBe("最近 1 条错误日志\nfixture-error-log-marker");

      host.stdin.write(`#日志 1 ${terminalMarker}\n#帮助\n`);
      host.stdin.flush();
      await readUntil(/Lotus-Yunzai 系统指令\n/u);
      expect(stdout).toContain(`最近 1 条运行日志\n${terminalMarker}\n`);

      host.kill();
      expect(await host.exited).toBe(143);
      expect(await stderr).not.toContain("处理 OneBot 事件失败");
      expect(bot.frames).toEqual([]);
      expect(unbound.frames).toEqual([]);
      const runtimeAfterTerminal = await readFile(runtime, "utf8");
      expect(runtimeAfterTerminal.match(new RegExp(terminalMarker, "gu"))).toHaveLength(1);
      expect(runtimeAfterTerminal).not.toContain("最近 1 条运行日志");
    } finally {
      reader.releaseLock();
    }
  } finally {
    for (const { socket } of clients) socket.close();
    if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await host?.exited;
    host?.stdin.end();
    clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
