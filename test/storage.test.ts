import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStorage, connectStorage, storage } from "@lotus-yunzai/storage";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const valkeyServer = Bun.which("valkey-server");

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

    expect(await command("#推送公告", 42)).toMatchObject({ action: "send_msg", params: {
      user_id: 42, message: "仅机器人主人可管理公告。",
    } });
    const discovery = await command("#推送公告");
    expect(discovery.action).toBe("get_group_list");
    const membership = [{ group_id: 77, group_name: "目标群" }, { group_id: 78, group_name: "群外" }];
    const delivery = await confirm(discovery.echo, membership);
    expect(delivery).toMatchObject({ action: "send_msg", params: {
      group_id: 77, auto_escape: true, message: "【公告通知】\n旧公告 [CQ:at,qq=all]\n2026-11-19 00:00",
    } });
    const summary = await confirm(delivery.echo, { message_id: -601 });
    expect(summary.params).toMatchObject({ user_id: 51, message: expect.stringContaining("确认送达 1") });
    const receipt = await command("#公告推送回执 00001ABC");
    expect(receipt.params).toMatchObject({ user_id: 51, message: expect.stringContaining("群 77 · 机器人 99 · 确认送达 · 消息 -601") });
    const second = await command("#推送公告");
    expect(second.action).toBe("get_group_list");
    const duplicate = await confirm(second.echo, membership);
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
    expect((await command([
      { type: "text", data: { text: "#发布公告 停机回执测试" } }, image,
      { type: "text", data: { text: "图后文字" } },
    ])).params).toMatchObject({
      user_id: 51, message: expect.stringContaining("公告已发布"),
    });
    const beforeShutdown = await command("#推送公告");
    expect(beforeShutdown.action).toBe("get_group_list");
    const outstanding = await confirm(beforeShutdown.echo, membership);
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
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root,
      env: { PATH: process.env.PATH, LOTUS_VALKEY_URL: url },
      stdin: new Blob(["#状态\n#公告\n#发布公告 未授权\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const hostTimeout = setTimeout(() => host.kill("SIGKILL"), 4_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited,
      ]);
      expect(exit).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("[存储] Valkey 已连接。");
      expect(stdout).toContain("Lotus-Yunzai 正在运行");
      expect(stdout).toContain("插件读取：旧版/原神");
      expect(stdout).toContain("清理时可连接：PONG");
      expect(stdout).toContain("旧公告 [CQ:at,qq=all]");
      expect(stdout).toContain("仅机器人主人可管理公告");
      expect(await legacy.get("notice:current")).toBe("00001ABC");
      expect(stdout).not.toContain(password);
    } finally {
      clearTimeout(hostTimeout);
    }

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
