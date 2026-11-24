import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginProbeTokenEnvironment } from "../lib/plugin-load-progress.ts";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const openssl = Bun.which("openssl");
const statusToken = "https-status-fixture";
const oneBotToken = "https-onebot-fixture";
const plainPublicBase = new URL("http://plain.example.invalid/bots/");
const securePublicBase = new URL("https://secure.example.invalid/lotus/");
const command = "#传输夹具";

function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function startupOutput(host: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const reader = host.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const part = await reader.read();
      if (part.done) throw new Error("TLS 测试宿主在启动完成前退出。\n" + output);
      output += decoder.decode(part.value, { stream: true });
    }
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function withHost(
  config: "valid" | "invalid" | "probe",
  run: (endpoints: { http: URL; https?: URL }, ca: string) => Promise<void>,
  httpsPort = 0,
) {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-https-"));
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    disableMemberPrewarm(root);
    await writeFile(join(root, "plugins", "https-fixture.js"), `
      let startup;
      let startupStatus;
      export default class extends plugin {
        constructor() {
          super({ event: "message.private", rule: [{ reg: "^${command}$", fnc: "publish" }] });
        }
        async init() {
          startup = String(await Bot.fileToUrl(Buffer.from("初始化文件内容")));
          Bot.express.post("/fixture/secure-notice", (req, res) => res.sendStatus(req.body?.secure === true ? 202 : 400));
          const probe = process.env.LOTUS_TEST_HTTPS_STARTUP_PROBE;
          if (probe) {
            try {
              const response = await fetch(probe, {
                headers: { Authorization: ${JSON.stringify(`Bearer ${statusToken}`)} },
                signal: AbortSignal.timeout(1_000),
              });
              startupStatus = response.status;
            } catch (error) {
              startupStatus = error.code ?? String(error);
            }
          }
        }
        async publish(e) {
          const current = String(await Bot.fileToUrl(Buffer.from("共用传输测试")));
          return e.reply(JSON.stringify({ startup, current, startupStatus }));
        }
      }
    `);
    if (config !== "invalid") {
      const create = Bun.spawnSync([
        openssl!, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
        "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
        "-keyout", "fixture.key", "-out", "fixture.crt",
      ], { cwd: root, stdout: "ignore", stderr: "pipe" });
      if (create.exitCode !== 0) throw new Error("生成测试证书失败。\n" + create.stderr.toString());
    } else {
      await writeFile(join(root, "fixture.key"), "invalid-test-private-key");
      await writeFile(join(root, "fixture.crt"), "invalid-test-certificate");
    }
    const ca = await readFile(join(root, "fixture.crt"), "utf8");
    // Keep the selected loopback port reserved until the configuration is ready.
    const reservation = config === "valid" && httpsPort === 0
      ? Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
      : undefined;
    const httpPort = reservation?.port ?? 0;
    try {
      await writeFile(join(root, "config", "server.yaml"), [
        `port: ${httpPort}`,
        `url: ${plainPublicBase.href}`,
        "https:",
        "  key: fixture.key",
        "  cert: fixture.crt",
        `  port: ${httpsPort}`,
        `  url: ${securePublicBase.href}`,
      ].join("\n") + "\n");
    } finally {
      reservation?.stop(true);
    }
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH, LOTUS_HTTP_TOKEN: statusToken,
        ...(config === "probe"
          ? { [pluginProbeTokenEnvironment]: "https-health-fixture", LOTUS_HTTP_PORT: "0" }
          : { LOTUS_ONEBOT_TOKEN: oneBotToken }),
        ...(httpPort ? { LOTUS_TEST_HTTPS_STARTUP_PROBE: `http://127.0.0.1:${httpPort}/status` } : {}),
      },
    });
    const stderr = new Response(host.stderr).text();
    const timeout = setTimeout(() => host.kill("SIGKILL"), 9_000);
    try {
      const output = await deadline(startupOutput(host), "TLS 测试宿主启动超时。");
      const http = /http:\/\/127\.0\.0\.1:\d+\/status/u.exec(output)?.[0];
      const https = /https:\/\/127\.0\.0\.1:\d+\/status/u.exec(output)?.[0];
      expect(http).toBeDefined();
      await run({ http: new URL(http!), https: https === undefined ? undefined : new URL(https) }, ca);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
      clearTimeout(timeout);
    }
    const diagnostics = await stderr;
    expect(diagnostics).not.toContain("处理 OneBot 事件失败");
    expect(diagnostics).not.toContain("invalid-test-private-key");
    return diagnostics;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function auth(token?: string) {
  return token === undefined ? undefined : { Authorization: `Bearer ${token}` };
}

function request(url: URL, token?: string, ca?: string, headers?: Record<string, string>) {
  return fetch(url, {
    headers: { ...auth(token), ...headers },
    tls: ca === undefined ? undefined : { ca },
    signal: AbortSignal.timeout(2_000),
  });
}

async function checkStatus(url: URL, ca?: string) {
  expect((await request(url, undefined, ca)).status).toBe(401);
  expect((await request(url, oneBotToken, ca)).status).toBe(401);
  const response = await request(url, statusToken, ca);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ok", name: "Lotus-Yunzai" });
}

async function getPublishedUrls(
  listener: URL, ca?: string,
): Promise<{ startup: string; current: string; startupStatus?: number | string }> {
  const endpoint = new URL("/OneBotv11", listener);
  endpoint.protocol = listener.protocol === "https:" ? "wss:" : "ws:";
  const BunWebSocket = WebSocket as unknown as new (url: URL, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(endpoint, {
    headers: { ...auth(oneBotToken), "X-Client-Role": "Universal", "X-Self-ID": "99" },
    tls: ca === undefined ? undefined : { ca },
  });
  try {
    const frame = await deadline(new Promise<{ action: string; params: { message: string } }>((resolve, reject) => {
      socket.addEventListener("message", ({ data }) => resolve(JSON.parse(data)), { once: true });
      socket.addEventListener("error", () => reject(new Error(`未能通过 ${endpoint.protocol} 连接 OneBot。`)), { once: true });
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        post_type: "message", message_type: "private", sub_type: "friend", self_id: 99, user_id: 42, message: command,
      })), { once: true });
    }), "未收到文件链接测试帧。");
    expect(frame).toMatchObject({ action: "send_msg", params: { message_type: "private", user_id: 42 } });
    return JSON.parse(frame.params.message);
  } finally {
    socket.close();
  }
}

async function checkPublishedFile(listener: URL, advertised: URL, ca?: string) {
  const { startup, current, startupStatus } = await getPublishedUrls(listener, ca);
  for (const [link, content] of [[current, "共用传输测试"], [startup, "初始化文件内容"]] as const) {
    const published = new URL(link);
    expect(published.origin).toBe(advertised.origin);
    expect(published.pathname).toStartWith(advertised.pathname + "File/");
    const local = new URL("/" + published.pathname.slice(advertised.pathname.length), listener);
    const response = await request(local, undefined, ca);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(content);
  }
  return startupStatus;
}

test.skipIf(!openssl)("TRSS 可选 HTTPS 与 WSS 共用 TLS 监听并发布 HTTPS 前缀", async () => {
  await withHost("valid", async ({ http, https }, ca) => {
    expect(https).toBeDefined();
    const secure = https!;
    expect(secure.port).not.toBe(http.port);
    await checkStatus(http);
    await checkStatus(secure, ca);
    const webhook = new URL("/fixture/secure-notice", secure);
    const post = {
      method: "POST", body: '{"secure":true}', tls: { ca }, signal: AbortSignal.timeout(2_000),
    };
    expect((await fetch(webhook, { ...post, headers: auth(oneBotToken) })).status).toBe(401);
    expect((await fetch(webhook, {
      ...post, headers: { ...auth(statusToken), "Content-Type": "application/json" },
    })).status).toBe(202);
    const upgrade = new URL("/OneBotv11", secure);
    expect((await request(upgrade, statusToken, ca, { "X-Client-Role": "Universal" })).status).toBe(401);
    expect((await request(upgrade, oneBotToken, ca)).status).toBe(400);
    expect(await checkPublishedFile(secure, securePublicBase, ca)).toBe(503);
  });
}, 12_000);

test("TRSS HTTPS 证书无效时 HTTP、OneBot 和原公开文件地址继续使用", async () => {
  await withHost("invalid", async ({ http, https }) => {
    expect(https).toBeUndefined();
    await checkStatus(http);
    await checkPublishedFile(http, plainPublicBase);
  });
}, 10_000);

test.each([["仅 HTTPS", false], ["显式 HTTP", true]] as const)(
  "%s 的 Milky Webhook 按实际可用的监听器启动", async (_name, explicitHttp) => {
    const root = await mkdtemp(join(tmpdir(), "lotus-milky-https-"));
    const accessToken = "milky-https-fixture";
    const webhookPath = "/fixture/milky";
    const account = 99;
    let loginAttempts = 0;
    const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/api/get_login_info") {
        return new Response(null, { status: 404 });
      }
      loginAttempts++;
      if (request.headers.get("Authorization") !== `Bearer ${accessToken}`) return new Response(null, { status: 401 });
      return Response.json({ status: "ok", retcode: 0, data: { uin: account, nickname: "Milky 夹具" } });
    } });
    try {
      await copyHost(root);
      const directory = join(root, "config");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "server.yaml"), Bun.YAML.stringify({
        ...(explicitHttp ? { port: 0 } : { onebot_enable: false }),
        https: { port: 0, key: "missing-fixture.key", cert: "missing-fixture.crt" },
      }));
      await writeFile(join(directory, "milky.yaml"), Bun.YAML.stringify({
        enable: true, host: "127.0.0.1", port: gateway.port, connection: "webhook",
        access_token: accessToken, webhook: { path: webhookPath },
      }));
      const token = crypto.randomUUID();
      const readiness: { milky: unknown; tls: unknown }[] = [];
      const host = Bun.spawn([process.execPath, "app.ts"], {
        cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH, LOTUS_MANAGED_TOKEN: token },
        ipc(message: unknown) {
          if (message && typeof message === "object" && "type" in message && message.type === "lotus-ready") {
            readiness.push({ milky: "milky" in message ? message.milky : undefined, tls: "tls" in message ? message.tls : undefined });
          }
        },
      });
      const stderr = new Response(host.stderr).text();
      try {
        if (!explicitHttp) {
          expect(await deadline(host.exited, "TLS-only 的 Milky Webhook 未退出。")).toBe(1);
          expect(await stderr).toContain("Milky webhook 未能启动可接收入站事件的 HTTP 或 HTTPS 监听。");
          expect(readiness).toEqual([]);
          expect(loginAttempts).toBe(0);
          return;
        }

        const output = await deadline(startupOutput(host), "Milky Webhook HTTP 对照未启动。");
        expect(output).not.toContain("HTTPS 正在监听");
        const address = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
        expect(address).toBeDefined();
        const webhook = new URL(webhookPath, address!);
        const post = {
          method: "POST", body: JSON.stringify({ self_id: account, event_type: "group_admin_change", data: {} }),
          signal: AbortSignal.timeout(2_000),
        };
        expect((await fetch(webhook, { ...post, headers: { "Content-Type": "application/json" } })).status).toBe(401);
        const headers = { "Content-Type": "application/json", ...auth(accessToken) };
        let response = await fetch(webhook, { ...post, headers });
        const readyUntil = Date.now() + 2_000;
        while (response.status === 503 && Date.now() < readyUntil) {
          await Bun.sleep(20);
          response = await fetch(webhook, { ...post, headers });
        }
        expect(response.status).toBe(200);
        expect(loginAttempts).toBe(1);
        expect(readiness).toEqual([{ milky: "webhook", tls: undefined }]);
      } finally {
        if (host.exitCode === null && host.signalCode === null) host.kill();
        await host.exited;
      }
      expect(await stderr).toContain("[HTTPS] 无法读取证书或启动监听，已跳过 HTTPS。");
    } finally {
      await gateway.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000,
);

test.skipIf(!openssl)("TRSS HTTPS 端口被占用时保留 HTTP 和原公开文件地址", async () => {
  const occupied = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    const diagnostics = await withHost("valid", async ({ http, https }) => {
      expect(https).toBeUndefined();
      expect(Number(http.port)).not.toBe(occupied.port);
      await checkStatus(http);
      await checkPublishedFile(http, plainPublicBase);
    }, occupied.port);
    expect(diagnostics.split("\n").filter((line) => line.includes("[HTTPS]")).map(line => line.slice(line.indexOf("[HTTPS]"))))
      .toEqual(["[HTTPS] 无法读取证书或启动监听，已跳过 HTTPS。"]);
  } finally {
    occupied.stop(true);
  }
}, 10_000);

test.skipIf(!openssl)("TRSS 更新健康探测仅启动临时 HTTP，即使配置了有效的 HTTPS 证书", async () => {
  await withHost("probe", async ({ http, https }) => {
    expect(https).toBeUndefined();
    await checkStatus(http);
  });
}, 10_000);
