import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

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
    disableMemberPrewarm(root);
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

type MilkyText = { type: "text"; data: { text: string } };
type MilkyForward = {
  type: "forward";
  data: { messages: { user_id: number; sender_name: string; segments: MilkyText[] }[] };
};
type MilkyLogTarget = { user_id: number } | { group_id: number };

function milkyLogGateway(accessToken: string) {
  const frames: { action: string; body: { message: (MilkyText | MilkyForward)[] } }[] = [];
  let receipt: "ok" | "rejected" | "unknown" = "ok";
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${accessToken}`) {
        return new Response(null, { status: 401 });
      }
      const path = new URL(request.url).pathname;
      if (path === "/api/get_login_info") {
        return Response.json({ status: "ok", retcode: 0, data: { uin: 99, nickname: "日志夹具" } });
      }
      if (path !== "/api/send_private_message" && path !== "/api/send_group_message") {
        return new Response(null, { status: 404 });
      }
      const body = await request.json() as (typeof frames)[number]["body"];
      frames.push({ action: path.slice("/api/".length), body });
      if (body.message[0]?.type === "forward") {
        if (receipt === "rejected") return Response.json({ status: "failed", retcode: -404, message: "夹具拒绝转发" });
        if (receipt === "unknown") return new Response(null, { status: 503 });
      }
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: 10 } });
    },
  });
  async function next(target: MilkyLogTarget) {
    const frame = await until(() => frames.shift(), "没有收到日志测试 Milky 动作。");
    expect(frame.action).toBe("group_id" in target ? "send_group_message" : "send_private_message");
    expect(frame.body).toMatchObject(target);
    return frame.body.message;
  }
  return {
    server, frames, next,
    setReceipt(value: typeof receipt) { receipt = value; },
    async singleText(target: MilkyLogTarget, value: string | ReturnType<typeof expect.stringContaining>) {
      expect(await next(target)).toEqual([{ type: "text", data: { text: value } }]);
    },
  };
}

test("Milky 私聊主人可查询脱敏日志，按原生转发回执决定文本回退", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-log-command-"));
  const accessToken = "milky-log-fixture";
  const mock = milkyLogGateway(accessToken);
  try {
    await copyHost(root);
    await mkdir(join(root, "config", "config"), { recursive: true });
    await writeFile(join(root, "config", "config", "other.yaml"), [
      'master: ["99:51", "100:52"]', "disablePrivate: true", "disableMsg: 私聊限制夹具",
    ].join("\n") + "\n");
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.url.port}`,
      "connection: webhook", `access_token: ${accessToken}`,
    ].join("\n") + "\n");
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, TZ: "UTC", LOTUS_HTTP_PORT: "0" },
    });
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    const stderr = new Response(host.stderr).text();
    const timeout = setTimeout(() => host.kill("SIGKILL"), 7_000);
    try {
      let output = "";
      while (!output.includes("Lotus-Yunzai 已启动")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Milky 日志测试宿主未启动。\n" + output);
        output += decoder.decode(chunk.value, { stream: true });
      }
      const origin = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
      if (!origin) throw new Error("Milky 日志测试宿主未输出 HTTP 监听地址。");
      const endpoint = new URL("/milky", origin);
      const time = Math.floor(Date.now() / 1_000);
      function deliver(event_type: string, data: object, self_id = 99) {
        return fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ time, self_id, event_type, data }),
          signal: AbortSignal.timeout(2_000),
        });
      }
      const bound = await until(async () => {
        const response = await deliver("fixture_unsupported", {});
        return response.status === 503 ? undefined : response.status;
      }, "Milky 日志测试没有绑定账号。");
      expect(bound).toBe(200);
      let sequence = 0;
      async function command(text: string, sender_id = 51, group?: number, account = 99) {
        const response = await deliver("message_receive", {
          time, message_seq: ++sequence, sender_id, peer_id: group ?? sender_id,
          message_scene: group === undefined ? "friend" : "group",
          segments: [{ type: "text", data: { text } }],
        }, account);
        expect(response.status).toBe(account === 99 ? 200 : 403);
      }
      const key = "milky-fixture-query";
      const day = new Date().toISOString().slice(0, 10);
      const runtime = join(root, "logs", `command.${day}.log`);
      await appendFile(runtime, [
        `${key} Cookie: ${unsafeMarkers[0]}`,
        `${key} Authorization: Bearer ${unsafeMarkers[1]}`,
        `${key} AuthKey=${unsafeMarkers[2]}`,
        "",
      ].join("\n"));
      await writeFile(join(root, "logs", "error.log"), "milky-fixture-error-line\n");

      const owner = { user_id: 51 };
      await command(`#日志 ${key}`, 51, undefined, 100);
      await command(`#日志 ${key}`, 51, 77);
      await command("#帮助", 51, 77);
      await mock.singleText({ group_id: 77 }, expect.stringContaining("Lotus-Yunzai 系统指令"));
      for (const user of [42, 52]) {
        await command(`#日志 ${key}`, user);
        await mock.singleText({ user_id: user }, "私聊限制夹具");
      }
      await command(`#日志 ${unsafeMarkers[0]}`);
      await mock.singleText(owner, "暂无相关运行日志。");

      async function forwarded(text: string) {
        await command(text);
        const message = await mock.next(owner);
        expect(message).toHaveLength(1);
        const forward = message[0];
        if (forward?.type !== "forward") throw new Error("Milky 日志测试未收到原生合并转发。");
        for (const node of forward.data.messages) {
          expect(node).toMatchObject({ user_id: 99, sender_name: "Lotus-Yunzai" });
          expect(node.segments).toEqual([{ type: "text", data: { text: expect.any(String) } }]);
        }
        const content = forward.data.messages.flatMap(({ segments }) => segments.map(({ data }) => data.text)).join("\n");
        for (const secret of unsafeMarkers) expect(content).not.toContain(secret);
        return content;
      }

      expect(await forwarded(`#日志 1 ${key}`)).toBe(`最近 1 条运行日志\n${key} AuthKey=[已隐藏]`);
      const filtered = await forwarded(`#运行日志 ${key}`);
      expect(filtered).toContain(`${key} Cookie: [已隐藏]`);
      expect(filtered).toContain(`${key} Authorization: [已隐藏]`);
      expect(filtered).not.toContain("Lotus-Yunzai 已启动");

      mock.setReceipt("rejected");
      const error = await forwarded("#错误日志");
      expect(error).toBe("最近 1 条错误日志\nmilky-fixture-error-line");
      await mock.singleText(owner, error);
      mock.setReceipt("unknown");
      expect(await forwarded(`#日志 1 ${key}`)).toContain(`${key} AuthKey=[已隐藏]`);
      await mock.singleText(owner, "日志转发结果未确认，请在聊天中核对。");

      await command("#帮助");
      await mock.singleText(owner, expect.stringContaining("Lotus-Yunzai 系统指令"));
      await Bun.sleep(80);
      expect(mock.frames).toEqual([]);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
      reader.releaseLock();
      clearTimeout(timeout);
    }
    const diagnostics = await stderr;
    for (const secret of unsafeMarkers) expect(diagnostics).not.toContain(secret);
  } finally {
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);

test("宿主兼容插件日志格式、原 ID 对齐和选项，不影响普通日志入口", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-plugin-log-format-"));
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    const config = join(root, "config/config/bot.yaml");
    await writeFile(join(root, "plugins/format-log-fixture.js"), `
      const data = { visible: 'structure-visible' };
      Object.defineProperty(data, 'invisible', { value: 'hidden-property-value' });
      Object.defineProperty(data, 'computed', { enumerable: true, get() {
        console.error('unexpected-getter-execution');
        return 'computed-value';
      } });
      data[Symbol.for('nodejs.util.inspect.custom')] = () => 'custom-inspect-executed';
      Bot.makeLog('info', ['literal %o', data, new Error('fixture-native-error')], '42');
      Bot.makeLog('info', 'fixture-no-id', false);
      Bot.makeLog('info', 'fixture-no-align', 'long-identity', true);
      Bot.makeLog('info', 'fixture-align', 'long-identity');
      Bot.makeLog('info', 'fixture-default');
      Bot.makeLog('debug', 'suppressed-plugin-log');
      Bot.makeLog('error', 'fixture-direct token=never-output-fixture-secret');
      Bot.makeLog('mark', 'fixture-plugin-mark', false);
      Bot.makeLog('fatal', 'fixture-plugin-fatal', false);
      Bot.makeLog('info', '0123456789abcdefghijklmnopqrstuvwxyz', false);
      console.info('fixture-ordinary-log');
      export default class extends plugin {}
    `);
    disableMemberPrewarm(root);
    for (const [configuration, expected] of [
      ['log_object: false\nlog_align: abcde\n', ["[  42 ]", "[long.] fixture-align", "[abcde] fixture-default", "[object Object]"]],
      ['log_object: { depth: 2, length: 32 }\nlog_align: "  TRSSYz  "\n',
        ["[    42    ]", "[long-iden.] fixture-align", "[  Lotus-Yunzai  ] fixture-default", "structure-visible"]],
    ] as const) {
      await writeFile(config, configuration);
      const host = Bun.spawn([process.execPath, "app.ts"], {
        cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH, TZ: "UTC", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
      });
      const stdout = new Response(host.stdout).text();
      const stderr = new Response(host.stderr).text();
      const day = new Date().toISOString().slice(0, 10);
      const runtime = join(root, "logs", `command.${day}.log`);
      try {
        const log = await until(async () => {
          const content = await readFile(runtime, "utf8").catch(() => "");
          return content.includes("fixture-ordinary-log") && content.includes("Lotus-Yunzai 已启动") ? content : undefined;
        }, "宿主没有写入原插件日志和启动完成行。");
        for (const value of expected) expect(log).toContain(value);
        expect(log).toContain("literal %o");
        expect(log).toContain("fixture-native-error");
        expect(log).toContain(" [INFO] fixture-no-id\n");
        expect(log).toContain("[long-identity] fixture-no-align");
        expect(log).toContain("fixture-direct token=[已隐藏]");
        expect(log).toContain("[MARK] fixture-plugin-mark");
        expect(log).toContain("[FATAL] fixture-plugin-fatal");
        expect(log).not.toMatch(/never-output-fixture-secret|unexpected-getter-execution|hidden-property-value|custom-inspect-executed|suppressed-plugin-log/u);
        if (configuration.includes("length: 32")) expect(log).toContain("0123456789abcdefghijklmnopqrstu…");
        const errors = await readFile(join(root, "logs/error.log"), "utf8");
        expect(errors).toContain("token=[已隐藏]");
        expect(errors).toContain("[FATAL] fixture-plugin-fatal");
      } finally {
        host.kill("SIGTERM");
        await host.exited;
      }
      expect(await stdout).toContain("ws://127.0.0.1:");
      expect(await stderr).not.toContain("never-output-fixture-secret");
      await rm(join(root, "logs"), { recursive: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
