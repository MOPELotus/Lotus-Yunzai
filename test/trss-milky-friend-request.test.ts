import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const token = "milky-friend-request-fixture";
const account = 99;
const now = 1_700_000_000;
const autoUid = "u_fixture_automatic";
const manualUid = "u_fixture_manually_rejected";
const unknownWarning = "[好友申请] 未确认自动审批结果。";

interface Review {
  action: string;
  body: unknown;
  receivedAt: number;
}

function deadline<T>(promise: Promise<T>, description: string, milliseconds = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), milliseconds);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function mockGateway() {
  const reviews: Review[] = [];
  const rejected = Promise.withResolvers<Review>();
  const accepted = Promise.withResolvers<Review>();
  const replayReply = Promise.withResolvers<unknown>();
  const ownerNotice = Promise.withResolvers<unknown>();
  const notifiedOwners: unknown[] = [];
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response(null, { status: 401 });
      }
      const action = new URL(request.url).pathname.slice("/api/".length);
      if (action === "get_login_info") {
        return Response.json({ status: "ok", retcode: 0, data: { uin: account, nickname: "审批夹具" } });
      }
      const body = await request.json();
      if (action === "send_private_message") {
        if (JSON.stringify(body).includes("添加好友申请")) {
          notifiedOwners.push(body);
          ownerNotice.resolve(body);
        } else replayReply.resolve(body);
        return Response.json({ status: "ok", retcode: 0, data: { message_seq: 11 } });
      }
      const review = { action, body, receivedAt: performance.now() };
      reviews.push(review);
      if (action === "reject_friend_request") {
        rejected.resolve(review);
        return Response.json({ status: "ok", retcode: 0, data: {} });
      }
      if (action === "accept_friend_request") {
        accepted.resolve(review);
        await release.promise;
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 404 });
    },
  });
  return { server, reviews, accepted, rejected, release, replayReply, ownerNotice, notifiedOwners };
}

async function startup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const part = await reader.read();
      if (part.done) throw new Error("Milky 好友审批宿主未启动。\n" + output);
      output += decoder.decode(part.value, { stream: true });
    }
    const origin = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
    if (!origin) throw new Error("Milky 好友审批宿主未输出 HTTP 监听地址。");
    return new URL("/milky", origin);
  } finally {
    reader.releaseLock();
  }
}

async function collectWarnings(stream: ReadableStream<Uint8Array>, unknown: () => void) {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stream) {
    output += decoder.decode(chunk, { stream: true });
    if (output.includes(unknownWarning)) unknown();
  }
  return output + decoder.decode();
}

function webhook(endpoint: URL, event: object, authenticated = true) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(event), signal: AbortSignal.timeout(2_000),
  });
}

async function waitForBind(endpoint: URL) {
  const event = { time: now, self_id: account, event_type: "fixture_unsupported", data: {} };
  const stopAt = performance.now() + 2_000;
  for (;;) {
    const response = await webhook(endpoint, event);
    if (response.status !== 503 || performance.now() >= stopAt) {
      expect(response.status).toBe(200);
      return;
    }
    await Bun.sleep(25);
  }
}

function request(initiator_id: number, initiator_uid: string, comment = "") {
  return {
    time: now,
    self_id: account,
    event_type: "friend_request",
    data: { initiator_id, initiator_uid, comment, via: "搜索" },
  };
}

test("Milky Webhook 好友申请按旧配置延时审批，保留 V3 手动拒绝及去重", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-friend-request-"));
  const mock = mockGateway();
  const replayMarker = join(root, "replay-probe");
  try {
    await copyHost(root);
    await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins", "group"), {
      recursive: true, filter: path => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
    });
    await mkdir(join(root, "config", "config"), { recursive: true });
    await writeFile(join(root, "config", "config", "other.yaml"), 'autoFriend: 1\nmaster: ["99:52", "100:54"]\n');
    await writeFile(join(root, "config", "group-notice.yaml"), 'default: { friendRequest: false }\n"bot:99": { friendRequest: true }\n');
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.port}`,
      "connection: webhook", `access_token: ${token}`,
    ].join("\n") + "\n");
    await writeFile(join(root, "plugins", "manual-review-fixture.js"), `
      export default class extends plugin {
        constructor() { super({ event: "request.friend.add" }); }
        async accept(e) {
          if (e.comment === "手动拒绝") return e.approve(false, "夹具拒绝");
          if (await Bun.file(${JSON.stringify(replayMarker)}).exists()) {
            const approved = await e.approve(true);
            await e.reply(approved ? "重放被同意" : "重放未再审批");
          }
        }
      }
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0" },
    });
    const unknown = Promise.withResolvers<void>();
    const stderr = collectWarnings(host.stderr, unknown.resolve);
    try {
      const endpoint = await deadline(startup(host.stdout), "Milky 好友审批宿主启动超时。", 3_000);
      await waitForBind(endpoint);
      expect((await webhook(endpoint, request(41, "u_fixture_untrusted"), false)).status).toBe(401);
      expect((await webhook(endpoint, { ...request(42, "u_fixture_foreign"), self_id: account + 1 })).status).toBe(403);
      const malformed = request(43, "u_fixture_malformed");
      expect((await webhook(endpoint, { ...malformed, data: { ...malformed.data, initiator_uid: 43 } })).status).toBe(200);

      expect((await webhook(endpoint, request(44, manualUid, "手动拒绝"))).status).toBe(200);
      const rejected = await deadline(mock.rejected.promise, "未收到 V3 插件的即时拒绝。");
      expect(rejected.action).toBe("reject_friend_request");
      expect(rejected.body).toEqual({ initiator_uid: manualUid, is_filtered: false, reason: "夹具拒绝" });
      const automatic = request(45, autoUid);
      const requestedAt = performance.now();
      const deliveries = await Promise.all([webhook(endpoint, automatic), webhook(endpoint, automatic)]);
      expect(deliveries.map(({ status }) => status)).toEqual([200, 200]);
      const review = await deadline(mock.accepted.promise, "未收到启用后的自动批准请求。", 4_500);
      expect(review.receivedAt - requestedAt).toBeGreaterThanOrEqual(2_900);
      expect(review.action).toBe("accept_friend_request");
      expect(review.body).toEqual({ initiator_uid: autoUid, is_filtered: false });

      await Bun.sleep(100);
      expect(mock.reviews.map(({ action }) => action)).toEqual(["reject_friend_request", "accept_friend_request"]);
      mock.release.resolve();
      await deadline(unknown.promise, "未观察到好友审批回执未确认的记录。");
      const notice = await deadline(mock.ownerNotice.promise, "当前 Milky 主人未收到自动审批未确认的通知。") as { user_id: number; message: unknown };
      expect(notice.user_id).toBe(52);
      const shown = JSON.stringify(notice.message);
      expect(shown).toContain("搜索");
      expect(shown).toContain("自动审批结果未确认");
      expect(shown).toContain("#查看好友申请");
      expect(shown).not.toContain(autoUid);
      await writeFile(replayMarker, "");
      expect((await webhook(endpoint, automatic)).status).toBe(200);
      expect(await deadline(mock.replayReply.promise, "未观察到 V3 插件对重放申请的审批结果。")).toEqual({
        user_id: 45, message: [{ type: "text", data: { text: "重放未再审批" } }],
      });
      expect(mock.reviews.map(({ action }) => action)).toEqual(["reject_friend_request", "accept_friend_request"]);
      expect(mock.notifiedOwners).toHaveLength(1);
    } finally {
      mock.release.resolve();
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
    }
    const warnings = await stderr;
    expect(warnings).not.toContain(autoUid);
    expect(warnings).not.toContain(token);
  } finally {
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 9_000);
