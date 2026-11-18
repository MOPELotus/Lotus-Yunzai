import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const route = "/fixture/legacy-notice";
const payload = JSON.stringify({ notice: { text: "测试消息", recipients: [7, 9] } });
const httpToken = "legacy-http-fixture";
const wsToken = "legacy-ws-fixture";
const panelToken = "legacy-panel-fixture";
const network = { "X-Fixture-Network": "fixture-only" };

async function readStartup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("兼容 HTTP 夹具未完成启动。\n" + output);
      output += decoder.decode(chunk.value, { stream: true });
    }
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function withHost(
  split: boolean,
  run: (endpoints: { http: URL; ws: URL; publicFile: URL }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-legacy-http-"));
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "server.yaml"), "port: 0\nauth:\n  X-Fixture-Network: fixture-only\n");
    await writeFile(join(root, "plugins", "legacy-http-fixture.js"), `
      export default class extends plugin {
        async init() {
          let invocations = 0;
          Bot.express.post(${JSON.stringify(route)}, async (req, res) => {
            invocations++;
            await Promise.resolve();
            const notice = req.body?.notice;
            if (notice?.text !== "测试消息" || !Array.isArray(notice.recipients) ||
                notice.recipients.join(",") !== "7,9") {
              return res.sendStatus(422);
            }
            return res.sendStatus(invocations === 1 ? 202 : 204);
          });
          for (const path of ["/status", "/panel/api/status", "/OneBotv11"]) {
            try { Bot.express.post(path, (_req, res) => res.sendStatus(418)); } catch {}
          }
          const file = await Bot.fileToUrl(Buffer.from("内置文件路由"));
          console.log("兼容 HTTP 夹具文件 " + file);
          try { Bot.express.post(new URL(file).pathname, (_req, res) => res.sendStatus(418)); } catch {}
        }
      }
    `);

    const reservation = split ? Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }) : undefined;
    const wsPort = reservation?.port;
    reservation?.stop(true);
    const child = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: {
        PATH: process.env.PATH, LOTUS_HTTP_TOKEN: httpToken, LOTUS_ONEBOT_TOKEN: wsToken, LOTUS_PANEL_TOKEN: panelToken,
        ...(wsPort === undefined ? {} : { LOTUS_ONEBOT_PORT: String(wsPort) }),
      },
    });
    const stderr = new Response(child.stderr).text();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 4_500);
    try {
      const output = await readStartup(child.stdout);
      const http = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
      const ws = /OneBot 11 正在监听 (ws:\/\/127\.0\.0\.1:\d+\/OneBotv11)/u.exec(output)?.[1];
      const publicFile = /兼容 HTTP 夹具文件 (http:\/\/127\.0\.0\.1:\d+\/File\/[^\s]+)/u.exec(output)?.[1];
      expect(http).toBeDefined();
      expect(ws).toBeDefined();
      expect(publicFile).toBeDefined();
      const wsUrl = new URL(ws!);
      wsUrl.protocol = "http:";
      await run({ http: new URL(http!), ws: wsUrl, publicFile: new URL(publicFile!) });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await child.exited;
      clearTimeout(timeout);
    }
    expect(await stderr).not.toContain("处理 OneBot 事件失败");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function request(origin: URL, pathname: string, options: RequestInit = {}) {
  return fetch(new URL(pathname, origin), { signal: AbortSignal.timeout(2_000), ...options });
}

function bearer(token: string) {
  return { ...network, Authorization: `Bearer ${token}` };
}

function post(body: BodyInit | null, headers: HeadersInit = bearer(httpToken), type = "application/json"): RequestInit {
  const combined = new Headers(headers);
  combined.set("Content-Type", type);
  return { method: "POST", headers: combined, body };
}

test("TRSS V3 插件 POST 复用 HTTP 鉴权及有界 JSON，并与专用 OneBot 端口分离", async () => {
  await withHost(true, async ({ http, ws, publicFile }) => {
    expect(http.port).not.toBe(ws.port);
    expect((await request(ws, route, post(payload))).status).toBe(404);
    expect((await request(http, ws.pathname, post(payload))).status).toBe(404);
    expect((await request(ws, ws.pathname, {
      headers: { ...bearer(wsToken), "X-Client-Role": "Universal" },
    })).status).toBe(426);

    for (const method of ["GET", "HEAD", "PUT", "OPTIONS"]) {
      expect((await request(http, route, { method, headers: bearer(httpToken) })).status).toBe(404);
    }
    expect((await request(http, route, post(payload, network))).status).toBe(401);
    expect((await request(http, route, post(payload, bearer(wsToken)))).status).toBe(401);
    expect((await request(http, route, post(payload, { Authorization: `Bearer ${httpToken}` }))).status).toBe(401);
    expect((await request(http, route, post("{", network))).status).toBe(401);
    expect((await request(http, route, post(payload, bearer(httpToken), "text/plain"))).status).toBe(415);
    expect((await request(http, route, post("{"))).status).toBe(400);
    expect((await request(http, route, post(null))).status).toBe(400);
    const tooLarge = JSON.stringify({ notice: "a".repeat(1_048_576) });
    expect((await request(http, route, post(tooLarge))).status).toBe(413);
    const oversizedStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(55_000).fill(0x20));
        controller.enqueue(new Uint8Array(55_000).fill(0x20));
        controller.close();
      },
    });
    expect((await request(http, route, post(oversizedStream))).status).toBe(413);

    const accepted = await request(http, route, post(payload, bearer(httpToken), "application/json; charset=utf-8"));
    expect(accepted.status).toBe(202);
    expect(await accepted.text()).toBe("Accepted");
    const empty = await request(http, route, post(payload));
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
    expect((await request(http, "/status", post(payload))).status).toBe(405);
    expect((await request(http, "/status", { headers: bearer(httpToken) })).status).toBe(200);
    expect((await request(http, "/panel/api/status", { headers: bearer(httpToken) })).status).toBe(401);
    expect((await request(http, "/panel/api/status", { headers: bearer(panelToken) })).status).toBe(200);
    expect((await request(http, "/panel/api/status", post(payload, bearer(panelToken)))).status).toBe(405);
    expect((await request(http, publicFile.pathname, post(payload))).status).toBe(405);
    const file = await request(http, publicFile.pathname);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("内置文件路由");
  });
}, 10_000);

test("TRSS V3 插件 POST 与 OneBot 共用监听时仍各用自己的鉴权", async () => {
  await withHost(false, async ({ http, ws }) => {
    expect(http.origin).toBe(ws.origin);
    expect((await request(http, route, post(payload, bearer(wsToken)))).status).toBe(401);
    expect((await request(http, route, post(payload))).status).toBe(202);
    expect((await request(ws, ws.pathname, {
      headers: { ...bearer(httpToken), "X-Client-Role": "Universal" },
    })).status).toBe(401);
    expect((await request(ws, ws.pathname, {
      headers: { ...bearer(wsToken), "X-Client-Role": "Universal" },
    })).status).toBe(426);
  });
}, 8_000);
