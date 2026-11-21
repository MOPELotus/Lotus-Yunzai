import { expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const time = 1_700_000_000;
type Reply = { action: string; params: Record<string, unknown>; echo?: string };

async function startup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const onebot = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      const http = /http:\/\/127\.0\.0\.1:\d+\/status/u.exec(output)?.[0];
      if (http && onebot) return { onebot, milky: new URL("/milky", http) };
      const chunk = await reader.read();
      if (chunk.done) throw new Error(output);
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

type Status = "ok" | "failed";
type Respond = (data: unknown, status?: Status) => void;
type Call = Reply & { respond: Respond };

function queue(timeoutMs: number) {
  const calls: Call[] = [];
  let ready = Promise.withResolvers<void>();
  return {
    calls,
    add(call: Call) { calls.push(call); ready.resolve(); },
    async next(action: string) {
      const timeout = Promise.withResolvers<never>();
      const timer = setTimeout(() => timeout.reject(new Error(`未收到 ${action}`)), timeoutMs);
      try {
        if (!calls.length) await Promise.race([ready.promise, timeout.promise]);
        const call = calls.shift()!;
        if (!calls.length) ready = Promise.withResolvers();
        expect(call.action).toBe(action);
        return call;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

interface Gateways {
  readonly root: string;
  readonly ws: WebSocket;
  readonly milky: ReturnType<typeof queue>;
  readonly onebot: ReturnType<typeof queue>;
  readonly sendOneBot: (text: string, fields?: object) => void;
  readonly sendMilky: (text: string, fields?: object, selfId?: number) => Promise<Response>;
}

export async function withDualGatewayFixture(token: string, ownerConfig: string, run: (gateway: Gateways) => Promise<void>,
  timeoutMs = 2_000,
) {
  const root = await mkdtemp(join(tmpdir(), "lotus-dual-gateway-"));
  const milky = queue(timeoutMs);
  const onebot = queue(timeoutMs);
  const sockets: WebSocket[] = [];
  const gateway = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const action = new URL(request.url).pathname.split("/").at(-1)!;
      if (action === "get_login_info") return Response.json({ status: "ok", retcode: 0, data: { uin: 100 } });
      const params = await request.json() as Reply["params"];
      const response = Promise.withResolvers<Response>();
      milky.add({ action, params, respond(data, status = "ok") {
        response.resolve(Response.json({ status, retcode: status === "ok" ? 0 : 1200, data }));
      } });
      return response.promise;
    },
  });
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "other.yaml"), ownerConfig);
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${gateway.port}`, "connection: webhook", `access_token: ${token}`, "",
    ].join("\n"));
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    try {
      const endpoints = await startup(host.stdout);
      const socketType = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
      const ws = new socketType(endpoints.onebot, { headers: {
        Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99",
      } });
      sockets.push(ws);
      const opened = Promise.withResolvers<void>();
      ws.addEventListener("open", () => opened.resolve(), { once: true });
      ws.addEventListener("error", () => opened.reject(new Error("OneBot 网关未连接")), { once: true });
      ws.addEventListener("message", ({ data }) => {
        const call = JSON.parse(data) as Reply;
        onebot.add({ ...call, respond(data, status = "ok") {
          ws.send(JSON.stringify({ echo: call.echo, status, retcode: status === "ok" ? 0 : 1200, data }));
        } });
      });
      await opened.promise;
      function webhook(event: object) {
        return fetch(endpoints.milky, { method: "POST", headers: {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        }, body: JSON.stringify(event), signal: AbortSignal.timeout(2_000) });
      }
      for (let attempts = 0; ; attempts++) {
        const result = await webhook({ event_type: "fixture", self_id: 100, time, data: {} });
        if (result.status === 200) break;
        if (result.status !== 503 || attempts >= 25) throw Error("Milky 网关未连接");
        await Bun.sleep(20);
      }
      let sequence = 0;
      function sendOneBot(message: string, fields: object = {}) {
        ws.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend", message_id: ++sequence,
          self_id: 99, user_id: 42, time, message, ...fields }));
      }
      async function sendMilky(text: string, fields: object = {}, self_id = 100) {
        return webhook({ event_type: "message_receive", self_id, time, data: {
          message_scene: "friend", sender_id: 43, peer_id: 43, time, message_seq: ++sequence,
          segments: [{ type: "text", data: { text } }], ...fields,
        } });
      }

      await run({ root, ws, milky, onebot, sendOneBot, sendMilky });
    } finally {
      for (const socket of sockets) socket.close();
      host.kill();
      await host.exited;
    }
  } finally {
    gateway.stop(true);
    await rm(root, { force: true, recursive: true });
  }
}
