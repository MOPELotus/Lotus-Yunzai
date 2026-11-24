import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStorage, connectStorage, storage } from "@lotus-yunzai/storage";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";
import { takeLegacyProcessReceipt } from "../lib/legacy-process-receipts.ts";

const valkeyServer = Bun.which("valkey-server");

async function runStorageHost(root: string, input: string, storageUrl?: string) {
  await mkdir(join(root, "config"), { recursive: true });
  const serverFile = join(root, "config/server.yaml");
  const previousServer = await Bun.file(serverFile).exists() ? await Bun.file(serverFile).text() : undefined;
  await writeFile(serverFile, "onebot_enable: false\n");
  const host = Bun.spawn([process.execPath, "app.ts"], {
    cwd: root,
    env: { PATH: process.env.PATH, ...(storageUrl === undefined ? {} : { LOTUS_VALKEY_URL: storageUrl }) },
    stdin: new Blob([input]), stdout: "pipe", stderr: "pipe",
    timeout: 4_000, killSignal: "SIGKILL",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited,
  ]);
  if (previousServer === undefined) await rm(serverFile);
  else await writeFile(serverFile, previousServer);
  return { stdout, stderr, exit };
}

async function verifyNoticePush(root: string, storageUrl: string) {
  const config = join(root, "config", "config");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "other.yaml"), 'master: ["99:51"]\n');
  await writeFile(join(config, "bot.yaml"), "online_msg_exp: 0\n");
  disableMemberPrewarm(root);
  const host = Bun.spawn([process.execPath, "app.ts"], {
    cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH, LOTUS_VALKEY_URL: storageUrl,
      LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: "notice-fixture",
    },
  });
  let socket: WebSocket | undefined;
  const timeout = setTimeout(() => host.kill("SIGKILL"), 4_000);
  const reader = host.stdout.getReader();
  try {
    let startup = "";
    const decoder = new TextDecoder();
    let endpoint: string | undefined;
    while (!endpoint) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`OneBot 未启动：${await new Response(host.stderr).text()}`);
      startup += decoder.decode(chunk.value, { stream: true });
      endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(startup)?.[0];
    }
    const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const client = new BunWebSocket(endpoint, {
      headers: { Authorization: "Bearer notice-fixture", "X-Client-Role": "Universal", "X-Self-ID": "99" },
    });
    socket = client;
    await new Promise<void>((resolve, reject) => {
      client.addEventListener("open", () => resolve(), { once: true });
      client.addEventListener("error", reject, { once: true });
    });

    function nextFrame(): Promise<{ action: string; echo: string; params: Record<string, unknown> }> {
      return new Promise((resolve, reject) => {
        const events = new AbortController();
        client.addEventListener("message", ({ data }) => {
          events.abort();
          resolve(JSON.parse(data));
        }, { signal: events.signal });
        client.addEventListener("close", () => {
          events.abort();
          reject(new Error("等待公告消息时连接关闭"));
        }, { signal: events.signal });
      });
    }

    function command(message: string | object[], user_id = 51) {
      const next = nextFrame();
      client.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend",
        self_id: 99, user_id, message }));
      return next;
    }

    function confirm(echo: string, data: unknown) {
      const next = nextFrame();
      client.send(JSON.stringify({ echo, status: "ok", retcode: 0, data }));
      return next;
    }

    async function confirmNoticeStart(echo: string, membership: unknown) {
      const start = await confirm(echo, membership);
      expect(start).toMatchObject({ action: "send_msg", params: {
        user_id: 51, message: expect.stringContaining("开始推送，共 1 个账号、1 个目标群"),
      } });
      return confirm(start.echo, { message_id: 600 });
    }

    expect(await command("#推送公告", 42)).toMatchObject({ action: "send_msg", params: {
      user_id: 42, message: "仅机器人主人可管理公告。",
    } });
    const discovery = await command("#推送公告");
    expect(discovery.action).toBe("get_group_list");
    const membership = [{ group_id: 77, group_name: "目标群" }, { group_id: 78, group_name: "群外" }];
    const delivery = await confirmNoticeStart(discovery.echo, membership);
    expect(delivery).toMatchObject({ action: "send_msg", params: {
      group_id: 77, auto_escape: true, message: "【公告通知】\n旧公告 [CQ:at,qq=all]\n2026-11-19 00:00",
    } });
    const summary = await confirm(delivery.echo, { message_id: -601 });
    expect(summary.params).toMatchObject({ user_id: 51, message: expect.stringContaining("确认送达 1") });
    const receipt = await command("#公告推送回执 00001ABC");
    expect(receipt.params).toMatchObject({ user_id: 51, message: expect.stringContaining("群 77 · 机器人 99 · 确认送达 · 消息 -601") });
    const second = await command("#推送公告");
    expect(second.action).toBe("get_group_list");
    const duplicate = await confirmNoticeStart(second.echo, membership);
    expect(duplicate.params).toMatchObject({ user_id: 51, message: expect.stringContaining("已跳过 1 个已有投递记录的群") });

    expect(await command("#撤回已发公告 00001ABC 77", 42)).toMatchObject({ action: "send_msg", params: {
      user_id: 42, message: "仅机器人主人可管理公告。",
    } });
    const recalled = await command("#撤回已发公告 00001ABC 77");
    expect(recalled).toMatchObject({ action: "delete_msg", params: { message_id: -601 } });
    expect((await confirm(recalled.echo, undefined)).params).toMatchObject({
      user_id: 51, message: expect.stringContaining("撤回已确认 1"),
    });
    expect((await command("#撤回已发公告 00001ABC 77")).params).toMatchObject({
      user_id: 51, message: expect.stringContaining("已跳过 1 条已有撤回记录的消息"),
    });
    expect((await command("#公告推送回执 00001ABC")).params).toMatchObject({
      user_id: 51, message: expect.stringContaining("撤回已确认"),
    });

    const image = { type: "image", data: { file: "https://example.invalid/notice.png" } };
    const published = await command([
      { type: "text", data: { text: "#发布公告停机回执测试" } }, image,
      { type: "text", data: { text: "图后文字" } },
    ]);
    expect(published.params).toMatchObject({
      user_id: 51, message: expect.stringContaining("公告已发布"),
    });
    const publishedNotice = await confirm(published.echo, { message_id: 601 });
    expect(publishedNotice).toMatchObject({ action: "send_msg", params: {
      user_id: 51,
      message: [
        { type: "text", data: { text: expect.stringContaining("【当前公告】") } },
        { type: "text", data: { text: "停机回执测试" } },
        image,
        { type: "text", data: { text: "图后文字" } },
      ],
    } });
    client.send(JSON.stringify({ echo: publishedNotice.echo, status: "ok", retcode: 0, data: { message_id: 602 } }));
    const beforeShutdown = await command("#推送公告");
    expect(beforeShutdown.action).toBe("get_group_list");
    const outstanding = await confirmNoticeStart(beforeShutdown.echo, membership);
    expect(outstanding).toMatchObject({ action: "send_msg", params: { group_id: 77, auto_escape: true,
      message: [
        { type: "text", data: { text: "【公告通知】\n" } },
        { type: "text", data: { text: "停机回执测试" } },
        image,
        { type: "text", data: { text: "图后文字" } },
        { type: "text", data: { text: expect.stringMatching(/^\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u) } },
      ],
    } });
    host.kill();
    const status = new URL("/status", endpoint.replace(/^ws/u, "http"));
    let stopping = false;
    for (let attempt = 0; attempt < 30 && !stopping; attempt++) {
      stopping = (await fetch(status)).status === 503;
      if (!stopping) await Bun.sleep(10);
    }
    expect(stopping).toBe(true);
    client.send(JSON.stringify({ echo: outstanding.echo, status: "ok", retcode: 0, data: { message_id: -602 } }));
    expect(await host.exited).toBe(143);
  } finally {
    clearTimeout(timeout);
    socket?.close();
    reader.releaseLock();
    if (host.exitCode === null) host.kill();
    await host.exited;
  }
}

test.skipIf(!valkeyServer)("独立 Valkey 实例验证新旧键空间、过期、事务与宿主启动", async () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  const password = "fixture-only-key";
  const url = `redis://:${password}@127.0.0.1:${port}/3`;
  const server = Bun.spawn([
    valkeyServer!, "--bind", "127.0.0.1", "--port", String(port),
    "--save", "", "--appendonly", "no", "--requirepass", password,
  ], { stdout: "pipe", stderr: "inherit" });
  let root: string | undefined;
  const timeout = setTimeout(() => server.kill("SIGKILL"), 7_000);
  const reader = server.stdout.getReader();
  try {
    const decoder = new TextDecoder();
    let startup = "";
    while (!startup.includes("Ready to accept connections")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Valkey 未启动：${startup}`);
      startup += decoder.decode(chunk.value, { stream: true });
    }

    const legacy = await connectStorage(url);
    const at = Date.now();
    const active = new AbortController().signal;
    const configured = { bots: [99, 100], terminal: false };
    const oldReceipt = JSON.stringify({ time: at, isExit: true, bot_id: "99", group_id: "77", user_id: 51 });
    await legacy.set("Yz:restart", oldReceipt);
    expect(await takeLegacyProcessReceipt(legacy, { botId: 100, signal: active }, configured)).toBeUndefined();
    expect(await legacy.get("Yz:restart")).toBe(oldReceipt);
    const entries = await Promise.all([
      takeLegacyProcessReceipt(legacy, { botId: 99, signal: active }, configured),
      takeLegacyProcessReceipt(legacy, { botId: 99, adapter: "milky", signal: active }, configured),
    ]);
    expect(entries.flatMap(entry => entry ? [entry.receipt] : [])).toEqual([expect.objectContaining({ at, kind: "stop",
      target: expect.objectContaining({ type: "group", botId: 99, id: 77 }) })]);
    expect(await legacy.get("Yz:restart")).toBeNull();

    await legacy.set("Yz:restart", JSON.stringify({ time: at }));
    expect((await takeLegacyProcessReceipt(legacy, { botId: 100, signal: active }, configured))?.receipt).toEqual({
      kind: "restart", at, target: { type: "masters", botId: 100 },
    });
    const closing = new AbortController();
    expect(await takeLegacyProcessReceipt({
      get: legacy.get.bind(legacy),
      async eval(script, options) {
        const result = await legacy.eval(script, options);
        if (Array.isArray(result) && typeof result[0] === "string") closing.abort();
        return result;
      },
    }, { botId: 99, signal: closing.signal }, configured)).toBeUndefined();
    expect((await takeLegacyProcessReceipt(legacy, { botId: 99, adapter: "milky", signal: active }, configured))?.receipt).toEqual({
      kind: "restart", at, target: { type: "masters", botId: 99, adapter: "milky" },
    });
    expect(await takeLegacyProcessReceipt(legacy, { botId: 100, signal: active }, configured)).toBeUndefined();

    await legacy.set("Yz:restart", JSON.stringify({ time: at }));
    const retry = await takeLegacyProcessReceipt(legacy, { botId: 99, adapter: "milky", signal: active },
      { ...configured, bots: [99] });
    expect(retry).toBeDefined();
    await retry!.restore({ pendingUsers: [53] });
    const pending = "lotus-yunzai:process:legacy-restart-targets";
    const expiresAt = () => legacy.eval("return redis.call('PEXPIRETIME', KEYS[1])", { keys: [pending], arguments: [] });
    const expiration = await expiresAt();
    expect(expiration).toBeGreaterThan(Date.now());
    expect(await takeLegacyProcessReceipt(legacy, { botId: 99, signal: active }, configured)).toBeUndefined();
    const repeated = await takeLegacyProcessReceipt(legacy, { botId: 99, adapter: "milky", signal: active }, configured);
    expect(repeated?.receipt).toEqual({ kind: "restart", at,
      target: { type: "masters", botId: 99, adapter: "milky", pendingUsers: [53] } });
    await repeated!.restore({ pendingUsers: [53] });
    expect(await expiresAt()).toBe(expiration);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
      takeLegacyProcessReceipt(legacy, { botId: 99, adapter: "milky", signal: active }, configured)));
    expect(concurrent.filter(Boolean)).toHaveLength(1);

    const atlas = storage("atlas");
    const genshin = storage("genshin");
    await legacy.set("shared", "旧版");
    await atlas.set("shared", "图鉴");
    await genshin.set("shared", "原神");
    expect(await legacy.get("shared")).toBe("旧版");
    expect(await atlas.get("shared")).toBe("图鉴");
    expect(await genshin.get("shared")).toBe("原神");

    await expect(atlas.write([
      { type: "set", key: "shared", value: "无效事务" },
      { type: "set", key: "bad-ttl", value: "无效", ttlSeconds: 0 },
    ])).rejects.toThrow("正整数");
    expect(await atlas.get("shared")).toBe("图鉴");
    await atlas.write([
      { type: "delete", key: "shared" },
      { type: "set", key: "temporary", value: "限时", ttlSeconds: 1 },
    ]);
    expect(await atlas.get("shared")).toBeNull();
    expect(await atlas.get("temporary")).toBe("限时");
    expect(await legacy.ttl("lotus-yunzai:atlas:temporary")).toBeGreaterThanOrEqual(0);
    await Bun.sleep(1_100);
    expect(await atlas.get("temporary")).toBeNull();

    root = await mkdtemp(join(tmpdir(), "lotus-yunzai-storage-"));
    await copyHost(root);
    await cp(new URL("../plugins/notice", import.meta.url), join(root, "plugins", "notice"), {
      recursive: true, filter: (path) => !path.endsWith("/.git"),
    });
    await legacy.set("notice:current", "00001ABC");
    await legacy.hSet("notice:ann:00001ABC", {
      creator: "42", status: "当前", timestamp: "2026-11-19 00:00",
      content: "旧公告 [CQ:at,qq=all]",
    });
    await writeFile(join(root, "plugins", "storage-check.js"), `
      import { storage } from "@lotus-yunzai/storage";
      export default class extends plugin {
        async init() {
          const oldValue = await redis.get("shared");
          const newValue = await storage("genshin").get("shared");
          console.log("插件读取：" + oldValue + "/" + newValue);
          this.addCleanup(async () => console.log("清理时可连接：" + await redis.ping()));
        }
      };
    `);
    const username = "fixture@acl:%";
    const aclPassword = 'yaml:/?#@%+=夹具"密码';
    expect(await legacy.sendCommand(["ACL", "SETUSER", username, "on", `>${aclPassword}`, "~*", "+@all"])).toBe("OK");
    await legacy.select(4);
    await legacy.set("shared", "优先配置");
    await legacy.set("lotus-yunzai:genshin:shared", "四号库");
    await legacy.select(3);

    const config = join(root, "config");
    await mkdir(join(config, "config"), { recursive: true });
    const marker = join(root, "redis-path-executed");
    const redisPath = join(root, "redis-path-fixture");
    await writeFile(redisPath, '#!/bin/sh\ntouch redis-path-executed\n', { mode: 0o700 });
    const yaml = (db: number, credential = aclPassword) => [
      "host: 127.0.0.1", `port: ${port}`, `username: ${JSON.stringify(username)}`,
      `password: ${JSON.stringify(credential)}`, `db: ${db}`, `path: ${JSON.stringify(redisPath)}`, "",
    ].join("\n");
    const flat = join(config, "redis.yaml");
    await writeFile(join(config, "config", "redis.yaml"), yaml(3));
    const nested = await runStorageHost(root, "#状态\n");
    expect(nested.exit).toBe(0);
    expect(nested.stderr.replace(/^.*\[更新\] 定时更新需要通过 bun run start 启动宿主。\n/gm, "")).toBe("");
    expect(nested.stdout).toContain("插件读取：旧版/原神");

    await writeFile(flat, yaml(4));
    const flattened = await runStorageHost(root, "#状态\n");
    expect(flattened.exit).toBe(0);
    expect(flattened.stderr.replace(/^.*\[更新\] 定时更新需要通过 bun run start 启动宿主。\n/gm, "")).toBe("");
    expect(flattened.stdout).toContain("插件读取：优先配置/四号库");

    const { stdout, stderr, exit } = await runStorageHost(root, "#状态\n#公告\n#发布公告 未授权\n", url);
    expect(exit).toBe(0);
    expect(stderr.replace(/^.*\[更新\] 定时更新需要通过 bun run start 启动宿主。\n/gm, "")).toBe("");
    expect(stdout).toContain("[存储] Valkey 已连接。");
    expect(stdout).toContain("Lotus-Yunzai 正在运行");
    expect(stdout).toContain("插件读取：旧版/原神");
    expect(stdout).toContain("清理时可连接：PONG");
    expect(stdout).toContain("旧公告 [CQ:at,qq=all]");
    expect(stdout).toContain("仅机器人主人可管理公告");
    expect(await legacy.get("notice:current")).toBe("00001ABC");
    expect(stdout).not.toContain(password);

    const invalidUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(aclPassword)}@127.0.0.1:${port}/3`;
    const rejected = await runStorageHost(root, "#状态\n", invalidUrl);
    expect(rejected.exit).toBe(1);
    expect(rejected.stderr).toContain("LOTUS_VALKEY_URL");
    expect(rejected.stdout).not.toContain("Valkey 已连接");
    const badPassword = `${aclPassword}-wrong`;
    await writeFile(flat, yaml(4, badPassword));
    const denied = await runStorageHost(root, "#状态\n");
    expect(denied.exit).toBe(1);
    expect(denied.stderr).toContain("Valkey 连接失败");
    expect(denied.stdout).not.toContain("Valkey 已连接");
    for (const output of [nested.stdout, flattened.stdout, rejected.stdout + rejected.stderr, denied.stdout + denied.stderr]) {
      for (const secret of [username, aclPassword, badPassword, encodeURIComponent(username), encodeURIComponent(aclPassword)]) {
        expect(output).not.toContain(secret);
      }
    }
    expect(await Bun.file(marker).exists()).toBe(false);

    await legacy.sAdd("notice:whitelist", "77");
    await verifyNoticePush(root, url);
    const currentNotice = await legacy.get("notice:current");
    expect(currentNotice).not.toBe("00001ABC");
    const duringShutdown = await legacy.hGet(`notice:delivery:${currentNotice}`, "77");
    expect(JSON.parse(duringShutdown ?? "null")).toMatchObject({ groupId: 77, state: "confirmed", messageId: -602 });

    await Promise.all([closeStorage(), closeStorage()]);
    expect(() => storage("atlas")).toThrow("存储未配置");
    const reopened = await connectStorage(url);
    expect(await reopened.get("shared")).toBe("旧版");
  } finally {
    await closeStorage();
    clearTimeout(timeout);
    reader.releaseLock();
    if (server.exitCode === null) server.kill("SIGTERM");
    await server.exited;
    if (root) await rm(root, { recursive: true, force: true });
  }
}, 10_000);
