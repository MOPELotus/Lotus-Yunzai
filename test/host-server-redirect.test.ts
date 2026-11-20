import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const redirectTarget = "https://public.example.invalid/welcome";
const httpToken = "redirect-http-fixture";
const panelToken = "redirect-panel-fixture";
const oneBotToken = "redirect-onebot-fixture";

function reservePort() {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function endpoints(host: Bun.Subprocess<"ignore", "pipe", "pipe">, stderr: Promise<string>) {
  const reader = host.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const http = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
      const gateway = /OneBot 11 正在监听 (ws:\/\/127\.0\.0\.1:\d+)\/OneBotv11/u.exec(output)?.[1];
      if (http && gateway) return { http: new URL(http), gateway: new URL(gateway) };
      const part = await reader.read();
      if (part.done) throw new Error(`跳转测试宿主未启动监听。\n${output}\n${await stderr}`);
      output += decoder.decode(part.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function withHost(shared: boolean, run: (listeners: Awaited<ReturnType<typeof endpoints>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-server-redirect-"));
  try {
    await copyHost(root);
    const config = join(root, shared ? "config" : "config/config");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "server.yaml"), `redirect: ${redirectTarget}\n`);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: shared ? "0" : String(reservePort()),
        LOTUS_HTTP_TOKEN: httpToken, LOTUS_PANEL_TOKEN: panelToken, LOTUS_ONEBOT_TOKEN: oneBotToken,
      },
    });
    const stderr = new Response(host.stderr).text();
    const timer = setTimeout(() => host.kill("SIGKILL"), 6_000);
    try {
      await run(await endpoints(host, stderr));
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
      clearTimeout(timer);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function request(base: URL, path: string, init: RequestInit = {}) {
  return fetch(new URL(path, base), { ...init, redirect: "manual", proxy: false, signal: AbortSignal.timeout(1_500) });
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function assertGatewayOpens(endpoint: URL, path: string) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new BunWebSocket(new URL(path, endpoint).href, {
    headers: { ...bearer(oneBotToken), "X-Client-Role": "Universal" },
  });
  const opened = Promise.withResolvers<void>();
  const timeout = setTimeout(() => opened.reject(new Error("OneBot 升级超时。")), 1_500);
  socket.addEventListener("open", () => opened.resolve(), { once: true });
  socket.addEventListener("error", () => opened.reject(new Error("OneBot 升级失败。")), { once: true });
  try {
    await opened.promise;
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}

test.each([["共享", true], ["分离", false]] as const)("%s监听区分公共 HTTP 跳转与 OneBot WebSocket 路由", async (_binding, shared) => {
  await withHost(shared, async ({ http, gateway }) => {
    expect(http.port === gateway.port).toBe(shared);
    const oneBotHttp = new URL(gateway);
    oneBotHttp.protocol = "http:";

    for (const method of ["GET", "HEAD"]) {
      const response = await request(http, "/unknown?fixture=ignored", { method });
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(redirectTarget);
      if (method === "HEAD") expect(await response.text()).toBe("");
    }
    expect((await request(http, "/unknown", { method: "POST" })).status).toBe(404);

    expect((await request(http, "/status")).status).toBe(401);
    const status = await request(http, "/status/", { headers: bearer(httpToken) });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: "ok" });
    const wrongMethod = await request(http, "/status", { method: "POST", headers: bearer(httpToken) });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("GET, HEAD");

    expect((await request(http, "/panel/api/status", { headers: bearer(panelToken) })).status).toBe(200);
    expect((await request(http, "/panel/api/unhandled", { headers: bearer(panelToken) })).status).toBe(404);
    expect((await request(http, "/File/not-a-token.png")).status).toBe(404);

    const upgrade = {
      Upgrade: "websocket", Connection: "Upgrade", "X-Client-Role": "Universal",
      "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "MDEyMzQ1Njc4OWFiY2RlZg==",
    };
    expect((await request(http, "/unknown", { headers: upgrade })).status).toBe(404);
    expect((await request(oneBotHttp, "/OneBotv11", { headers: upgrade })).status).toBe(401);
    expect((await request(oneBotHttp, "/OneBotv11", {
      headers: { ...bearer(oneBotToken), "X-Client-Role": "Universal" },
    })).status).toBe(426);
    await assertGatewayOpens(gateway, "/OneBotv11");

    const legacyPath = "/OneBotv11/gateways/qq?instance=primary";
    expect((await request(oneBotHttp, legacyPath)).status).toBe(404);
    expect((await request(oneBotHttp, legacyPath, { headers: upgrade })).status).toBe(401);
    expect((await request(oneBotHttp, legacyPath, {
      headers: { ...upgrade, ...bearer(oneBotToken), "X-Client-Role": "API" },
    })).status).toBe(400);
    for (const nearby of ["/OneBotv11x/gateways/qq", "/onebotv11/gateways/qq", "/OneBotv11%2fgateways/qq"]) {
      expect((await request(oneBotHttp, nearby, { headers: { ...upgrade, ...bearer(oneBotToken) } })).status).toBe(404);
    }
    await assertGatewayOpens(gateway, legacyPath);

    if (!shared) {
      expect((await request(oneBotHttp, "/unknown")).status).toBe(404);
      expect((await request(oneBotHttp, "/unknown", { headers: upgrade })).status).toBe(404);
      expect((await request(http, "/OneBotv11")).status).toBe(404);
      expect((await request(http, legacyPath, { headers: { ...upgrade, ...bearer(oneBotToken) } })).status).toBe(404);
    }
  });
}, 8_000);
