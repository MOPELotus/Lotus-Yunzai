import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const valkeyServer = Bun.which("valkey-server");
const token = "fixture-milky-notice";
const notice = "00001ABC";
const firstGroup = 77;
const secondGroup = 78;

async function waitUntil<T>(get: () => Promise<T | undefined>, label: string) {
  const deadline = Date.now() + 3000;
  do {
    const value = await get();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  } while (Date.now() < deadline);
  throw new Error("未观察到 " + label);
}

function output(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let log = "";
  void (async () => {
    for await (const chunk of stream) log += decoder.decode(chunk, { stream: true });
  })();
  return () => log;
}

test.skipIf(!valkeyServer)("Milky 公告已发送后，SIGTERM 允许有限窗口内的有效回执落盘", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-shutdown-"));
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const storageUrl = "redis://127.0.0.1:" + port + "/3";
  const valkey = Bun.spawn([valkeyServer!, "--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no"], {
    cwd: root, stdout: "pipe", stderr: "inherit",
  });
  const valkeyLog = output(valkey.stdout);
  const client = new Bun.RedisClient(storageUrl);
  const received = Promise.withResolvers<number>();
  const unblock = Promise.withResolvers<void>();
  const sends: number[] = [];
  const gateway = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== "Bearer " + token) return new Response(null, { status: 401 });
      const ack = (data: Record<string, unknown>) => Response.json({ status: "ok", retcode: 0, data });
      const action = new URL(request.url).pathname;
      const body = await request.json() as { group_id: number };
      if (action === "/api/get_login_info") return ack({ uin: 99, nickname: "隔离网关" });
      if (action === "/api/get_group_list") return ack({ groups: [{ group_id: firstGroup }, { group_id: secondGroup }] });
      if (action === "/api/send_group_message") {
        sends.push(body.group_id);
        received.resolve(body.group_id);
        await unblock.promise;
        return ack({ message_seq: 302, time: 1_700_000_000 });
      }
      return new Response(null, { status: 404 });
    },
  });
  let host: ReturnType<typeof spawn> | undefined;
  function spawn() {
    return Bun.spawn([process.execPath, "--preload", "./signal-fixture.ts", "app.ts"], {
      cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_VALKEY_URL: storageUrl, LOTUS_HTTP_PORT: "0" },
      timeout: 7500, killSignal: "SIGKILL",
    });
  }
  try {
    await waitUntil(async () => valkeyLog().includes("Ready to accept connections") || undefined, "隔离 Valkey 就绪");
    await client.connect();
    await client.send("SET", ["notice:current", notice]);
    await client.send("HSET", ["notice:ann:" + notice, "creator", "51", "status", "当前", "push", "未推送", "timestamp", "2026-11-20 00:00", "content", "Milky 关机回执模拟"]);
    await client.send("SADD", ["notice:whitelist", String(firstGroup), String(secondGroup)]);
    await copyHost(root);
    await cp(new URL("../plugins/notice", import.meta.url), join(root, "plugins", "notice"), {
      recursive: true, filter: (path) => !path.endsWith("/.git"),
    });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "other.yaml"), 'master: ["99:51", "stdin:stdin"]\n');
    await writeFile(join(root, "config", "bot.yaml"), "online_msg_exp: 0\n");
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", "port: " + gateway.port, "connection: webhook", "access_token: " + token,
    ].join("\n") + "\n");
    await writeFile(join(root, "signal-fixture.ts"), 'process.once("SIGTERM", () => queueMicrotask(() => console.log("fixture-sigterm-dispatched")));\n');
    host = spawn();
    const stdout = output(host.stdout);
    const stderr = output(host.stderr);
    const origin = await waitUntil(async () => {
      if (host?.exitCode !== null) throw new Error("宿主提前退出：" + stdout() + stderr());
      if (!stdout().includes("Lotus-Yunzai 已启动")) return;
      return /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(stdout())?.[1];
    }, "宿主监听");
    const time = 1_700_000_000;
    const webhook = (event_type: string, data: object) => fetch(origin + "/milky", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ time, self_id: 99, event_type, data }),
    });
    await waitUntil(async () => (await webhook("fixture_unsupported", {})).status === 200 || undefined, "已认证 Milky 会话");
    host.stdin.write("#推送公告\n");
    host.stdin.flush();
    expect(await Promise.race([received.promise, Bun.sleep(3000).then(() => { throw new Error("宿主未发起投递：" + stdout() + stderr()); })])).toBe(firstGroup);
    const key = "notice:delivery:" + notice;
    const stored = async (group: number) => {
      const raw = await client.send("HGET", [key, String(group)]);
      return raw === null ? null : JSON.parse(raw);
    };
    expect(await stored(firstGroup)).toMatchObject({ state: "pending", adapter: "milky" });
    host.kill("SIGTERM");
    await waitUntil(async () => stdout().includes("fixture-sigterm-dispatched") || undefined, "宿主收到 SIGTERM");
    unblock.resolve();
    expect(await host.exited).toBe(143);
    expect(sends).toEqual([firstGroup]);
    expect(await stored(secondGroup)).toBeNull();
    expect(await stored(firstGroup)).toMatchObject({ state: "unknown", milkyState: "confirmed", adapter: "milky", messageId: 302 });
    expect(await client.send("HGET", ["notice:ann:" + notice, "push"])).toBe("已推送");
  } finally {
    unblock.resolve();
    if (host?.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await host?.exited;
    gateway.stop(true);
    client.close();
    valkey.kill("SIGTERM");
    await valkey.exited;
    await rm(root, { force: true, recursive: true });
  }
}, 9500);
