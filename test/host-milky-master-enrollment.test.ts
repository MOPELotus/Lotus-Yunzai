import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const milkyToken = "milky-enrollment-fixture";
const oneBotToken = "onebot-enrollment-fixture";
const botId = 99;
const owner = 51;
const applicant = 42;
const secondApplicant = 43;
const reconnectingApplicant = 44;
const time = 1_700_000_000;
const restricted = "请使用账户入口";
const invalid = "申请或验证码无效，或已过期。请重新申请。";
const granted = "已设置为当前机器人的主人。";
const granting = "主人设置正在处理。";

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function replyQueue<T>(adapter: string) {
  const frames: T[] = [];
  let ready = Promise.withResolvers<void>();
  return {
    frames,
    add(frame: T) {
      frames.push(frame);
      ready.resolve();
    },
    async next() {
      if (!frames.length) await deadline(ready.promise, `未收到 ${adapter} 的主人授权回复。`);
      const frame = frames.shift()!;
      if (!frames.length) ready = Promise.withResolvers<void>();
      return frame;
    },
  };
}

function milkyGateway() {
  const frames = replyQueue<{ user_id: number; message: { type: "text"; data: { text: string } }[] }>("Milky");
  const relogin = Promise.withResolvers<void>();
  const releaseRelogin = Promise.withResolvers<void>();
  let sequence = 100;
  let logins = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${milkyToken}`) {
        return new Response(null, { status: 401 });
      }
      const path = new URL(request.url).pathname;
      if (path === "/api/get_login_info") {
        if (++logins > 1) {
          relogin.resolve();
          await releaseRelogin.promise;
        }
        return Response.json({ status: "ok", retcode: 0, data: { uin: botId, nickname: "主人授权夹具" } });
      }
      if (path !== "/api/send_private_message") return new Response(null, { status: 404 });
      frames.add(await request.json() as (typeof frames.frames)[number]);
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: ++sequence, time } });
    },
  });
  return {
    server, frames: frames.frames, relogin, releaseRelogin,
    async reply(user_id: number) {
      const actual = await frames.next();
      const text = actual.message[0]?.data.text;
      if (typeof text !== "string") throw new Error("Milky 主人授权夹具未收到文本。");
      expect(actual).toEqual({ user_id, message: [{ type: "text", data: { text } }] });
      return text;
    },
  };
}

async function oneBotGateway(endpoint: string) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(endpoint, {
    headers: { Authorization: `Bearer ${oneBotToken}`, "X-Client-Role": "Universal", "X-Self-ID": String(botId) },
  });
  const frames = replyQueue<{ action: string; params: { message_type: string; user_id: number; message: string } }>("OneBot");
  let sequence = 0;
  socket.addEventListener("message", ({ data }) => frames.add(JSON.parse(data)));
  try {
    await deadline(new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("OneBot 主人授权夹具连接失败。")), { once: true });
    }), "OneBot 主人授权夹具未连接。");
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    socket, frames: frames.frames,
    command(message: string, user_id: number) {
      socket.send(JSON.stringify({
        self_id: botId, post_type: "message", message_type: "private", sub_type: "friend",
        message_id: ++sequence, user_id, message,
      }));
    },
    async reply(user_id: number) {
      const actual = await frames.next();
      expect(actual.action).toBe("send_msg");
      expect(actual.params).toMatchObject({ message_type: "private", user_id });
      expect(typeof actual.params.message).toBe("string");
      return actual.params.message;
    },
  };
}

async function startup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("主人授权测试宿主未启动。\n" + output);
      output += decoder.decode(chunk.value, { stream: true });
    }
    const origin = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
    const oneBot = /OneBot 11 正在监听 (ws:\/\/127\.0\.0\.1:\d+\/OneBotv11)/u.exec(output)?.[1];
    if (!origin || !oneBot) throw new Error("主人授权测试宿主未输出 HTTP 或 OneBot 地址。");
    return { milky: new URL("/milky", origin), oneBot, output };
  } finally {
    reader.releaseLock();
  }
}

async function remainingOutput(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  return output + decoder.decode();
}

function milkyWebhook(endpoint: URL) {
  let seq = 0;
  function deliver(event_type: string, data: object) {
    return fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${milkyToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ time, self_id: botId, event_type, data }),
      signal: AbortSignal.timeout(2_000),
    });
  }
  return {
    async bind() {
      const stopAt = performance.now() + 2_000;
      for (;;) {
        const result = await deliver("fixture_unsupported", {});
        if (result.status !== 503 || performance.now() >= stopAt) {
          expect(result.status).toBe(200);
          return;
        }
        await Bun.sleep(25);
      }
    },
    async command(text: string, sender_id: number) {
      const result = await deliver("message_receive", {
        time, message_seq: ++seq, sender_id, peer_id: sender_id, message_scene: "friend",
        segments: [{ type: "text", data: { text } }],
      });
      expect(result.status).toBe(200);
    },
    async offline() {
      expect((await deliver("bot_offline", { reason: "夹具切换会话" })).status).toBe(200);
    },
    async expectOffline() {
      expect((await deliver("fixture_unsupported", {})).status).toBe(503);
    },
  };
}

function application(text: string) {
  const value = /申请编号[：:]\s*([a-f\d]{8})/iu.exec(text)?.[1];
  if (!value) throw new Error("主人授权夹具未返回申请编号。");
  return value;
}

function verification(text: string) {
  const value = /验证码[：:]\s*([a-f\d]{16})/iu.exec(text)?.[1];
  if (!value) throw new Error("主人授权夹具未返回验证码。");
  return value;
}

test("Milky 与 OneBot 主人授权各自签发和兑换，同一份配置安全更新", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-master-enrollment-"));
  const gateway = milkyGateway();
  let oneBot: Awaited<ReturnType<typeof oneBotGateway>> | undefined;
  try {
    await copyHost(root);
    const directory = join(root, "config", "config");
    await mkdir(directory, { recursive: true });
    const configFile = join(directory, "other.yaml");
    const lockFilePath = join(directory, ".other.yaml.lotus-master.sqlite");
    const original = [
      "# 主人配置注释", 'master: ["99:51", "100:61"]', "masterQQ: [51, 61]",
      "disablePrivate: true", `disableMsg: ${restricted}`, "foreign: { enabled: false }", "",
    ].join("\n");
    await writeFile(configFile, original);
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${gateway.server.url.port}`,
      "connection: webhook", `access_token: ${milkyToken}`, "ws:", "  reconnect_interval: 0.05",
    ].join("\n") + "\n");
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: oneBotToken },
    });
    const stderr = new Response(host.stderr).text();
    const codes: string[] = [];
    let logged = "";
    let remaining: Promise<string> | undefined;
    try {
      const endpoint = await deadline(startup(host.stdout), "主人授权测试宿主启动超时。");
      logged = endpoint.output;
      remaining = remainingOutput(host.stdout);
      oneBot = await oneBotGateway(endpoint.oneBot);
      const milky = milkyWebhook(endpoint.milky);
      await milky.bind();

      await milky.command("#状态", applicant);
      expect(await gateway.reply(applicant)).toBe(restricted);
      await milky.command("#设置主人", applicant);
      const milkyRequest = application(await gateway.reply(applicant));
      await Bun.sleep(1_020);
      oneBot.command("#设置主人", applicant);
      const oneBotRequest = application(await oneBot.reply(applicant));
      expect(milkyRequest).not.toBe(oneBotRequest);

      oneBot.command(`#设置主人验证码 ${milkyRequest}`, owner);
      expect(await oneBot.reply(owner)).toBe(invalid);
      await milky.command(`#设置主人验证码 ${oneBotRequest}`, owner);
      expect(await gateway.reply(owner)).toBe(invalid);
      await milky.command(`#设置主人验证码 ${milkyRequest}`, applicant);
      expect(await gateway.reply(applicant)).toBe("仅当前机器人的主人可签发验证码。");

      await Bun.sleep(1_020);
      await milky.command(`#设置主人验证码 ${milkyRequest}`, owner);
      const milkyCode = verification(await gateway.reply(owner));
      oneBot.command(`#设置主人验证码 ${oneBotRequest}`, owner);
      const oneBotCode = verification(await oneBot.reply(owner));
      codes.push(milkyCode, oneBotCode);
      oneBot.command(`#设置主人 ${milkyCode}`, applicant);
      expect(await oneBot.reply(applicant)).toBe(invalid);
      await milky.command(`#设置主人 ${oneBotCode}`, applicant);
      expect(await gateway.reply(applicant)).toBe(invalid);
      expect(await readFile(configFile, "utf8")).toBe(original);

      oneBot.command("#设置主人", secondApplicant);
      const second = application(await oneBot.reply(secondApplicant));
      oneBot.command(`#设置主人验证码 ${second}`, owner);
      const secondCode = verification(await oneBot.reply(owner));
      codes.push(secondCode);
      await Bun.sleep(1_020);
      const lock = await lockFile(lockFilePath, "测试主人配置");
      try {
        oneBot.command(`#设置主人 ${secondCode}`, secondApplicant);
        await milky.command(`#设置主人 ${milkyCode}`, applicant);
        await Bun.sleep(100);
        expect(gateway.frames).toEqual([]);
        expect(oneBot.frames).toEqual([]);
        expect(await readFile(configFile, "utf8")).toBe(original);
      } finally {
        lock.close();
      }
      expect(await gateway.reply(applicant)).toBe(granted);
      expect(await oneBot.reply(secondApplicant)).toBe(granted);

      await milky.command("#诊断", applicant);
      expect(await gateway.reply(applicant)).toMatch(/账号在线时长\n99　Milky　\d+ 秒/u);
      oneBot.command("#诊断", secondApplicant);
      expect(await oneBot.reply(secondApplicant)).toMatch(/账号在线时长\n99　\d+ 秒/u);
      const saved = await readFile(configFile, "utf8");
      expect(saved).toContain("# 主人配置注释");
      expect(Bun.YAML.parse(saved)).toMatchObject({
        master: expect.arrayContaining(["99:51", "100:61", "99:42", "99:43"]),
        masterQQ: expect.arrayContaining([51, 61, 42, 43]),
        disablePrivate: true, disableMsg: restricted, foreign: { enabled: false },
      });

      await milky.command("#设置主人", reconnectingApplicant);
      const pending = application(await gateway.reply(reconnectingApplicant));
      await milky.command(`#设置主人验证码 ${pending}`, owner);
      const staleCode = verification(await gateway.reply(owner));
      codes.push(staleCode);
      await Bun.sleep(1_020);
      const reconnectLock = await lockFile(lockFilePath, "测试下线时主人配置");
      try {
        await milky.command(`#设置主人 ${staleCode}`, reconnectingApplicant);
        await milky.command("#设置主人", reconnectingApplicant);
        expect(await gateway.reply(reconnectingApplicant)).toBe(granting);
        await milky.offline();
        await deadline(gateway.relogin.promise, "Milky 夹具下线后未重新查询登录。");
        await milky.expectOffline();
        expect(await readFile(configFile, "utf8")).toBe(saved);
      } finally {
        reconnectLock.close();
      }
      gateway.releaseRelogin.resolve();
      await milky.bind();
      await Bun.sleep(1_020);
      const stopAt = performance.now() + 2_000;
      for (;;) {
        await milky.command(`#设置主人 ${staleCode}`, reconnectingApplicant);
        const reply = await gateway.reply(reconnectingApplicant);
        if (reply !== granting || performance.now() >= stopAt) {
          expect(reply).toBe(invalid);
          break;
        }
        await Bun.sleep(1_020);
      }
      await milky.command("#诊断", reconnectingApplicant);
      expect(await gateway.reply(reconnectingApplicant)).toBe(restricted);
      expect(await readFile(configFile, "utf8")).toBe(saved);
      await milky.command("#诊断", applicant);
      expect(await gateway.reply(applicant)).toMatch(/账号在线时长\n99　Milky　\d+ 秒/u);
      oneBot.command("#诊断", secondApplicant);
      expect(await oneBot.reply(secondApplicant)).toMatch(/账号在线时长\n99　\d+ 秒/u);

      await milky.command("#设置主人", reconnectingApplicant);
      const fresh = application(await gateway.reply(reconnectingApplicant));
      expect(fresh).not.toBe(pending);
      await milky.command(`#设置主人验证码 ${fresh}`, owner);
      const freshCode = verification(await gateway.reply(owner));
      codes.push(freshCode);
      await milky.command(`#设置主人 ${freshCode}`, reconnectingApplicant);
      expect(await gateway.reply(reconnectingApplicant)).toBe(granted);
      const savedAfterReconnect = await readFile(configFile, "utf8");
      expect(Bun.YAML.parse(savedAfterReconnect)).toMatchObject({
        master: expect.arrayContaining(["99:51", "100:61", "99:42", "99:43", "99:44"]),
        masterQQ: expect.arrayContaining([51, 61, 42, 43, 44]),
      });
      for (const code of codes) expect(savedAfterReconnect).not.toContain(code);
      expect(gateway.frames).toEqual([]);
      expect(oneBot.frames).toEqual([]);
    } finally {
      gateway.releaseRelogin.resolve();
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
    }
    const logDirectory = join(root, "logs");
    const fileLogs = await Promise.all((await readdir(logDirectory)).filter((file) => file.endsWith(".log"))
      .map((file) => readFile(join(logDirectory, file), "utf8")));
    const output = [logged, await remaining, await stderr, ...fileLogs].join("\n");
    for (const code of codes) expect(output).not.toContain(code);
  } finally {
    oneBot?.socket.close();
    gateway.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
