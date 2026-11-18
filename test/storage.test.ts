import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStorage, connectStorage, storage } from "@lotus-yunzai/storage";
import { copyHost } from "./host-fixture.ts";

const valkeyServer = Bun.which("valkey-server");
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
