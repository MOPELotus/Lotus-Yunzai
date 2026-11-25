import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageLegacyCoreConfig } from "../lib/migration-core-config.ts";
import { formatShanghaiDate } from "../lib/shanghai-date.ts";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "log-command-fixture";
const startupMarker = "fixture-plugin-startup-marker";
const terminalMarker = "fixture-terminal-log-marker";
const inlineData = Buffer.alloc(144, 65).toString("base64");
const inlineImage = "data:image/png;base64," + inlineData;
const oneBotMediaData = Buffer.from("fixture-onebot-private-media").toString("base64");
const inlineSummary = "data:image/png;base64,[图片 Base64 省略，192 字符]";
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

test.each([
  ["精简对象和自定义对齐", "log_length: 48\nlog_object: false\nlog_align: abcde\n",
    "[long.] migration-object [object Object]", "migration-length " + "A".repeat(30) + "…"],
  ["对象选项和 YAML 空对齐", "log_length: 96\nlog_object: {length: 32, depth: 0, getters: true, unknownAuth: fixture-opaque}\nlog_align:\n",
    "[long-identity] migration-object { accepted: [Object] }", "migration-length " + "A".repeat(31) + "…"],
  ["排序、数字分组和展开布局", "log_length: 180\nlog_object: {compact: false, sorted: true, numericSeparator: true}\nlog_align:\n",
    "[long-identity] migration-style {   a: 12_345,   z: 1 }", "migration-length " + "A".repeat(80)],
  ["按列宽展开", "log_length: 180\nlog_object: {breakLength: 12}\nlog_align:\n",
    "[long-identity] migration-style {   z: 1,   a: 12345 }", "migration-length " + "A".repeat(80)],
] as const)("旧日志配置迁入后经 OneBot 消息生效：%s", async (_name, configuration, objectLine, lengthLine) => {
  const fixture = await mkdtemp(join(tmpdir(), "lotus-migrated-log-fixture-"));
  try {
    const source = join(fixture, "old"), root = join(fixture, "new");
    await mkdir(join(source, "config/config"), { recursive: true });
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(source, "config/config/bot.yaml"), "cache_group_member: false\n" + configuration);
    await stageLegacyCoreConfig(source, root);
    expect(await readFile(join(root, "config/config/bot.yaml"), "utf8")).not.toContain("fixture-opaque");
    await copyHost(root);
    await writeFile(join(root, "plugins/migrated-log-fixture.js"), `
      export default class extends plugin {
        constructor() { super({ event: "message", rule: [{ reg: "^#迁移格式联验$", fnc: "sample" }] }); }
        async sample() {
          Bot.makeLog("info", ["migration-object", { accepted: { sample: true } }], "long-identity");
          Bot.makeLog("info", ["migration-style", { z: 1, a: 12345 }], "long-identity");
          Bot.makeLog("info", ["migration-length", "A".repeat(80)], false);
          await this.reply("已记录迁移日志");
        }
      }
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, TZ: "UTC", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token } });
    let client: ReturnType<typeof connect> | undefined;
    const stop = setTimeout(() => host.kill("SIGKILL"), 7_000);
    try {
      const stream = host.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "", endpoint: string | undefined;
      try {
        while (!endpoint) {
          const next = await stream.read();
          if (next.done) throw Error("迁移日志夹具没有启动。");
          buffer += decoder.decode(next.value, { stream: true });
          endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(buffer)?.[0];
        }
      } finally { stream.releaseLock(); }
      const bot = client = connect(endpoint, 99);
      await until(() => bot.socket.readyState === WebSocket.OPEN ? true : undefined, "迁移日志夹具未绑定网关。");
      bot.command("#迁移格式联验", 42, 77);
      expect(JSON.stringify(await bot.next())).toContain("已记录迁移日志");
      const file = join(root, "logs", `command.${formatShanghaiDate(new Date())}.log`);
      const log = await until(async () => {
        const text = await readFile(file, "utf8").catch(() => "");
        return text.includes("migration-length") ? text : undefined;
      }, "迁入后没有写入聊天插件日志。");
      expect(log).toContain(objectLine);
      expect(log).toContain(lengthLine);
    } finally {
      clearTimeout(stop);
      client?.socket.close();
      host.kill("SIGTERM");
      await host.exited;
    }
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test.each([["默认日志目录", false], ["历史日志目录软链", true]] as const)("%s 只向授权终端和已绑定机器人的私聊主人发送脱敏内容", async (_label, linked) => {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-log-command-"));
  const clients: ReturnType<typeof connect>[] = [];
  let host: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    if (linked) {
      await mkdir(join(root, "data/logs"), { recursive: true });
      await symlink("data/logs", join(root, "logs"));
    }
    await Promise.all([
      writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51", "stdin:stdin"]\n'),
      writeFile(join(root, "plugins/log-fixture.js"), `throw new Error(${JSON.stringify(startupMarker)});`),
      writeFile(join(root, "plugins/log-error-fixture.js"), `
        console.error("fixture-new-error token=fixture-local-secret");
        console.error(new Error("fixture-native-inline 前文😀 " + ${JSON.stringify(inlineImage)} + " 末尾"));
        Bot.makeLog("warn", "fixture-v3-inline " + ${JSON.stringify(inlineImage)}, false);
        Bot.makeLog("warn", ["fixture-v3-onebot", segment.image("base64://" + ${JSON.stringify(oneBotMediaData)})], false);
        console.error("fixture-native-onebot " + ${JSON.stringify("base64://" + oneBotMediaData)} + ", next");
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
      const day = formatShanghaiDate(new Date());
      const runtime = join(root, "logs", `command.${day}.log`);
      const readyLog = await until(async () => {
        const content = await readFile(runtime, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return "";
        });
        return content.includes("Lotus-Yunzai 已启动") ? content : undefined;
      }, "宿主未创建当日运行日志。");
      if (linked) expect(await readlink(join(root, "logs"))).toBe("data/logs");
      expect(readyLog).toContain(startupMarker);
      expect(readyLog).toContain("fixture-new-error token=[已隐藏]");
      const errorLog = await readFile(join(root, "logs/error.log"), "utf8");
      expect(errorLog).toContain("fixture-new-error token=[已隐藏]");
      expect(errorLog).not.toContain("fixture-local-secret");
      expect(errorLog).toContain(`Error: fixture-native-inline 前文😀 ${inlineSummary} 末尾`);
      expect(errorLog).toMatch(/at [^\n]*log-error-fixture\.js:\d+:/u);
      expect(errorLog).not.toContain(inlineData);
      expect(readyLog).toContain(`fixture-v3-inline ${inlineSummary}`);
      expect(readyLog).not.toContain(inlineData);
      expect(readyLog).toContain("fixture-v3-onebot");
      expect(readyLog).toContain("base64://[媒体 Base64 省略]");
      expect(readyLog).not.toContain(oneBotMediaData);
      expect(errorLog).toContain("fixture-native-onebot base64://[媒体 Base64 省略], next");
      expect(errorLog).not.toContain(oneBotMediaData);

      await Promise.all([
        appendFile(runtime, [
          "fixture-query-key oldest line",
          `fixture-query-key Cookie: ${unsafeMarkers[0]}`,
          `fixture-query-key Authorization: Bearer ${unsafeMarkers[1]}`,
          `fixture-query-key newest AuthKey=${unsafeMarkers[2]}`,
          `fixture-historical-inline 中文😀 ${inlineImage} 末尾 token=fixture-inline-secret`,
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
          action: "send_msg", params: { ...expectedTarget, message: expect.stringContaining("https://www.lotusshared.cn/yunzai/") },
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

      const log = await forwarded("#日志");
      expect(log).toContain(startupMarker);
      expect(log).toContain(`fixture-historical-inline 中文😀 ${inlineSummary} 末尾 token=[已隐藏]`);
      expect(log).not.toContain(inlineData);
      expect(log).not.toContain("fixture-inline-secret");
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
      await readUntil(/https:\/\/www\.lotusshared\.cn\/yunzai\/\n/u);
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
      const day = formatShanghaiDate(new Date());
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
      await mock.singleText({ group_id: 77 }, expect.stringContaining("https://www.lotusshared.cn/yunzai/"));
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
      await Bun.sleep(1_020);
      mock.setReceipt("unknown");
      expect(await forwarded(`#日志 1 ${key}`)).toContain(`${key} AuthKey=[已隐藏]`);
      await mock.singleText(owner, "日志转发结果未确认，请在聊天中核对。");

      await command("#帮助");
      await mock.singleText(owner, expect.stringContaining("https://www.lotusshared.cn/yunzai/"));
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
      const day = formatShanghaiDate(new Date());
      const runtime = join(root, "logs", `command.${day}.log`);
      try {
        const log = await until(async () => {
          const content = await readFile(runtime, "utf8").catch(() => "");
          return content.includes("fixture-ordinary-log") && content.includes("Lotus-Yunzai 已启动") ? content : undefined;
        }, "宿主没有写入原插件日志和启动完成行。");
        for (const value of expected) expect(log).toContain(value);
        expect(log).toContain("literal %o");
        expect(log).toContain("fixture-native-error");
        expect(log).toContain("][INFO] fixture-no-id\n");
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

test("日志等级两协议即时生效，停机后由新进程读回，外改失败保留并可恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-host-log-level-"));
  const accessToken = "milky-log-level-fixture";
  const mock = milkyLogGateway(accessToken);
  const config = join(root, "config/config/bot.yaml");
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51", "99:53"]\n');
    await writeFile(join(root, "config/milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.url.port}`, "connection: webhook",
      `access_token: ${accessToken}`, "",
    ].join("\n"));
    const original = "# preserve-log-fixture\nfile_watch: false\ncache_group_member: false\nonline_msg_exp: 0\nlog_level: info\n";
    await writeFile(config, original);
    await writeFile(join(root, "plugins/log-level-fixture.js"), `
      export default class extends plugin {
        constructor() { super({ event: "message", rule: [{ reg: "^#测试等级标记[0-9]+$", fnc: "sample" }] }); }
        async sample() {
          const id = this.e.msg.slice(-1);
          console.debug("native-probe-" + id + "-debug");
          for (const level of ["trace", "debug", "info", "mark", "error"]) {
            Bot.makeLog(level, "bot-probe-" + id + "-" + level, false);
            logger[level]("logger-probe-" + id + "-" + level);
          }
          await this.reply("已记录测试日志");
        }
      }
    `);
    const runtime = join(root, "logs", `command.${formatShanghaiDate(new Date())}.log`);
    async function withHost(run: (gateway: ReturnType<typeof connect>, endpoint: URL) => Promise<void>) {
      const child = Bun.spawn([process.execPath, "app.ts"], {
        cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore",
        env: { PATH: process.env.PATH, TZ: "UTC", LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
      });
      let gateway: ReturnType<typeof connect> | undefined;
      let output = "";
      const capture = (async () => {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          output += decoder.decode(item.value, { stream: true });
        }
      })();
      try {
        await until(() => output.includes("Lotus-Yunzai 已启动") ? true : undefined, "日志等级宿主未就绪。");
        const ws = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
        const http = /http:\/\/127\.0\.0\.1:\d+\/status/u.exec(output)?.[0];
        if (!ws || !http) throw new Error("日志等级宿主缺监听。");
        gateway = connect(ws, 99);
        await until(() => gateway?.socket.readyState === WebSocket.OPEN ? true : undefined, "日志等级 OneBot 未连接。");
        await run(gateway, new URL("/milky", http));
      } finally {
        gateway?.socket.close();
        child.kill("SIGTERM");
        await child.exited;
        await capture;
      }
    }
    async function oneBot(gateway: ReturnType<typeof connect>, text: string, reply: string, user = 51) {
      gateway.command(text, user);
      const message = await gateway.next();
      expect(message.params.message).toContain(reply);
      gateway.confirm(message);
    }
    async function check(gateway: ReturnType<typeof connect>, sample: number, low: readonly string[]) {
      await oneBot(gateway, `#测试等级标记${sample}`, "已记录测试日志");
      const contents = await until(async () => {
        const contents = await readFile(runtime, "utf8");
        return contents.includes(`logger-probe-${sample}-error`) ? contents : undefined;
      }, "等待等级测试落盘超时。");
      for (const prefix of ["bot", "logger"]) {
        for (const level of ["trace", "debug", "info", "mark", "error"]) {
          expect(contents.includes(`${prefix}-probe-${sample}-${level}`)).toBe(low.includes(level) || level === "mark" || level === "error");
        }
      }
      expect(contents.includes(`native-probe-${sample}-debug`)).toBe(low.includes("debug"));
    }

    await withHost(async (gateway, endpoint) => {
      await oneBot(gateway, "#设置日志等级 off", "暂无权限", 41);
      expect(await readFile(config, "utf8")).toBe(original);
      await oneBot(gateway, "设置日志等级debug", "已将日志等级设置为debug");
      expect(await readFile(config, "utf8")).toBe(original.replace("log_level: info", "log_level: debug"));
      await check(gateway, 1, ["debug", "info"]);
      function deliver(event_type: string, data: object) {
        return fetch(endpoint, {
          method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: 99, event_type, data }),
          signal: AbortSignal.timeout(2_000),
        });
      }
      await until(async () => (await deliver("fixture_unsupported", {})).status === 200 ? true : undefined, "Milky 未绑定。");
      let sequence = 0;
      async function milky(text: string, reply: string, peerId = 53) {
        const message_scene = peerId === 53 ? "friend" : "group";
        const response = await deliver("message_receive", {
          message_seq: ++sequence, sender_id: 53, peer_id: peerId, message_scene,
          segments: [{ type: "text", data: { text } }],
        });
        expect(response.status).toBe(200);
        await mock.singleText(message_scene === "group" ? { group_id: peerId } : { user_id: peerId }, reply);
      }
      await milky("#修改日志等级 mark", "已将日志等级设置为mark", 77);
      await check(gateway, 6, []);
      await Promise.all([
        oneBot(gateway, "#修改日志等级 debug", "已将日志等级设置为debug"),
        milky("#修改日志等级 off", "已将日志等级设置为off"),
      ]);
      const saved = (Bun.YAML.parse(await readFile(config, "utf8")) as Record<string, unknown>).log_level;
      expect(saved === "debug" || saved === "off").toBe(true);
      await check(gateway, 2, saved === "debug" ? ["debug", "info"] : []);
      if (saved !== "off") await oneBot(gateway, "#设置日志等级off", "已将日志等级设置为off");
    });
    expect(await readFile(config, "utf8")).toBe(original.replace("log_level: info", "log_level: off"));

    const watching = original.replace("file_watch: false", "file_watch: true");
    await writeFile(config, watching.replace("log_level: info", "log_level: off"));
    await withHost(async gateway => {
      await check(gateway, 3, []);
      await writeFile(config, "[malformed\n");
      await oneBot(gateway, "#设置日志等级 trace", "无法保存日志等级");
      await check(gateway, 4, []);
      await writeFile(config, watching.replace("log_level: info", "log_level: trace"));
      await Bun.sleep(1_150);
      await check(gateway, 5, ["trace", "debug", "info"]);
      await oneBot(gateway, "#修改日志等级 trace", "日志等级已是trace了");
      expect(await readFile(config, "utf8")).toBe(watching.replace("log_level: info", "log_level: trace"));
    });
  } finally {
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 14_000);
