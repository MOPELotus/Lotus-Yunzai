import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readMilkySettings } from "../lib/adapters/milky-config.ts";

async function withMilkyConfig(run: (root: URL, write: (body: string, legacy?: boolean) => Promise<void>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-milky-config-"));
  try {
    await run(pathToFileURL(`${directory}/`), async (body, legacy = false) => {
      const config = join(directory, legacy ? "config/config" : "config");
      await mkdir(config, { recursive: true });
      await writeFile(join(config, "milky.yaml"), body);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Milky 默认关闭，读取旧路径并优先使用当前配置", async () => {
  await withMilkyConfig(async (root, write) => {
    expect(await readMilkySettings(root)).toBeUndefined();
    await write("enable: true\n", true);
    const defaults = await readMilkySettings(root);
    expect(defaults?.apiBase.href).toBe("http://127.0.0.1:3000/api/");
    expect(defaults?.eventUrl.href).toBe("ws://127.0.0.1:3000/event");
    expect(defaults).toMatchObject({ connection: "ws", webhookPath: "/milky", timeoutMs: 15_000, reconnectMs: 10_000, heartbeatMs: 30_000 });
    expect(defaults?.accessToken).toBeUndefined();
    await write("enable: 1\nhttp_timeout: 0\nws: {reconnect_interval: 0, heartbeat: 0}\n");
    expect(await readMilkySettings(root)).toMatchObject({ timeoutMs: 15_000, reconnectMs: 10_000, heartbeatMs: 30_000 });
    await write("enable: 0\nhost: [ignored]\n");
    expect(await readMilkySettings(root)).toBeUndefined();
  });
});

test("Milky 保留代理前缀、显式协议端口、IPv6 和毫秒配置", async () => {
  await withMilkyConfig(async (root, write) => {
    await write(`enable: true
host: https://gateway.example.invalid:8443
port: 3001
prefix: /Proxy/Milky/
connection: webhook
webhook:
  path: /Webhook/Milky/
access_token: fixture-token
http_timeout: 0.5
ws:
  reconnect_interval: "0.025"
  heartbeat: 20
`);
    const settings = await readMilkySettings(root);
    expect(settings?.apiBase.href).toBe("https://gateway.example.invalid:8443/Proxy/Milky/api/");
    expect(settings?.eventUrl.href).toBe("wss://gateway.example.invalid:8443/Proxy/Milky/event");
    expect(settings).toMatchObject({ connection: "webhook", webhookPath: "/webhook/milky", timeoutMs: 500, reconnectMs: 25, heartbeatMs: 20_000, accessToken: "fixture-token" });

    await write("enable: true\nhost: '::1'\nport: '3001'\nssl: true\n");
    expect((await readMilkySettings(root))?.apiBase.href).toBe("https://[::1]:3001/api/");
    await write("enable: true\nhost: 'http://[::1]:443'\nuse_ssl: true\n");
    expect((await readMilkySettings(root))?.eventUrl.href).toBe("ws://[::1]:443/event");
    await write("enable: true\nport: 443\n");
    expect((await readMilkySettings(root))?.eventUrl.href).toBe("wss://127.0.0.1/event");
  });
});

test("Milky 拒绝非 HTTP 目的地、保留路径和无效令牌或时间配置", async () => {
  await withMilkyConfig(async (root, write) => {
    for (const [input, field] of [
      ['host: "https://fixture-secret@gateway.example.invalid"', "host"],
      ["host: ftp://gateway.example.invalid", "host"], ["host: https://gateway.example.invalid/?q=1", "host"],
      ["host: 0.0.0.0", "host"], ["port: 0", "port"], ["port: 65536", "port"],
      ["prefix: /proxy/../alt", "prefix"], ["prefix: //not-a-prefix", "prefix"], ["connection: sse", "connection"],
      ["webhook: {path: /panel/route}", "webhook.path"], ["webhook: {path: '/:route'}", "webhook.path"],
      ['access_token: "fixture secret"', "access_token"], ["http_timeout: -1", "http_timeout"],
      ["ws: {heartbeat: -1}", "ws.heartbeat"], ["ws: {reconnect_interval: 2147484}", "ws.reconnect_interval"],
    ]) {
      await write(`enable: true\n${input}\n`);
      await expect(readMilkySettings(root)).rejects.toThrow(`config/milky.yaml 的 ${field} 无效。`);
    }
  });
});
