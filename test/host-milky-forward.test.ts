import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const token = "milky-forward-fixture";
const botId = 99;
const senderId = 42;
const groupId = 77;
const time = 1_700_000_000;
const title = "Lotus-Yunzai 更新日志，共2条";
const subject = "记录夹具提交";
const dummySecret = "fixture-credential";

type Receipt = "confirmed" | "rejected" | "malformed" | "unavailable";
type TextSegment = { type: "text"; data: { text: string } };
type ForwardSegment = {
  type: "forward";
  data: { messages: { user_id: number; sender_name: string; segments: TextSegment[] }[] };
};
interface GroupSend {
  group_id: number;
  message: (TextSegment | ForwardSegment)[];
}

function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function git(root: string, ...args: string[]) {
  const git = Bun.spawnSync([
    "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgSign=false", ...args,
  ], {
    cwd: root, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (git.exitCode !== 0) throw new Error(`Milky 日志夹具 Git ${args[0]} 失败。\n${git.stderr.toString()}`);
}

function mockGateway() {
  let receipt: Receipt = "confirmed";
  let ready = Promise.withResolvers<void>();
  const sent: GroupSend[] = [];
  let handled = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response(null, { status: 401 });
      }
      const path = new URL(request.url).pathname;
      if (path === "/api/get_login_info") {
        return Response.json({ status: "ok", retcode: 0, data: { uin: botId, nickname: "夹具登录名" } });
      }
      if (path !== "/api/send_group_message") return new Response(null, { status: 404 });
      const send = await request.json() as GroupSend;
      sent.push(send);
      ready.resolve();
      if (!Array.isArray(send.message) || send.message[0]?.type !== "forward") {
        return Response.json({ status: "ok", retcode: 0, data: { message_seq: 100, time } });
      }
      switch (receipt) {
        case "rejected": return Response.json({ status: "failed", retcode: -404, message: "拒绝合并转发" });
        case "malformed": return Response.json({ status: "ok", retcode: 0, data: { message_seq: "101" } });
        case "unavailable": return new Response(null, { status: 503 });
        case "confirmed": return Response.json({ status: "ok", retcode: 0, data: { message_seq: 101, time } });
      }
    },
  });
  return {
    server, sent,
    setReceipt(value: Receipt) { receipt = value; },
    async next(): Promise<GroupSend> {
      if (handled === sent.length) await deadline(ready.promise, "Milky 未收到更新日志回复。");
      const result = sent[handled++]!;
      if (handled === sent.length) ready = Promise.withResolvers<void>();
      return result;
    },
  };
}

async function startup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const part = await reader.read();
      if (part.done) throw new Error("Milky 日志测试宿主未启动。\n" + output);
      output += decoder.decode(part.value, { stream: true });
    }
    const origin = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
    if (!origin) throw new Error("Milky 日志测试宿主未输出 HTTP 监听地址。");
    return new URL("/milky", origin);
  } finally {
    reader.releaseLock();
  }
}

function webhook(endpoint: URL, data: object) {
  return fetch(endpoint, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(data), signal: AbortSignal.timeout(2_000),
  });
}

async function waitForBind(endpoint: URL) {
  const event = { time, self_id: botId, event_type: "fixture_unsupported", data: {} };
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

test("Milky 更新日志只在明确拒绝合并转发时回退正文", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-forward-"));
  const mock = mockGateway();
  try {
    await copyHost(root);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.port}`,
      "connection: webhook", `access_token: ${token}`,
    ].join("\n") + "\n");
    git(root, "init", "--quiet");
    git(root, "add", "app.ts");
    git(root, "commit", "--quiet", "-m", subject);
    git(root, "commit", "--quiet", "--allow-empty", "-m", `保留接口 Authorization: Bearer ${dummySecret}`);

    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0" },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const endpoint = await deadline(startup(host.stdout), "Milky 日志测试宿主启动超时。");
      await waitForBind(endpoint);
      const receipts = ["confirmed", "rejected", "malformed", "unavailable"] as const;
      for (const [index, receipt] of receipts.entries()) {
        mock.setReceipt(receipt);
        const before = mock.sent.length;
        expect((await webhook(endpoint, {
          time, self_id: botId, event_type: "message_receive",
          data: {
            message_scene: "group", peer_id: groupId, sender_id: senderId, time, message_seq: 10 + index,
            segments: [{ type: "text", data: { text: "#更新日志" } }],
          },
        })).status).toBe(200);

        const forward = await mock.next();
        expect(forward).toEqual({
          group_id: groupId,
          message: [{ type: "forward", data: {
            messages: [
              { user_id: botId, sender_name: "Lotus-Yunzai", segments: [{ type: "text", data: { text: title } }] },
              { user_id: botId, sender_name: "Lotus-Yunzai", segments: [{
                type: "text", data: { text: expect.stringContaining("保留接口 Authorization: [已隐藏]") },
              }] },
            ],
          } }],
        });
        const segment = forward.message[0] as ForwardSegment;
        const body = segment.data.messages[1]!.segments[0]!.data.text;
        expect(body).toContain(subject);
        expect(body).not.toContain(dummySecret);
        if (receipt !== "confirmed") {
          const expectedReply = receipt === "rejected"
            ? `${title}\n\n${body}`
            : "更新日志转发结果未确认，请在聊天中核对。";
          expect(await mock.next()).toEqual({ group_id: groupId, message: [{ type: "text", data: { text: expectedReply } }] });
        }
        await Bun.sleep(80);
        expect(mock.sent).toHaveLength(before + (receipt === "confirmed" ? 1 : 2));
      }
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
    }
    expect(await stderr).not.toContain(dummySecret);
  } finally {
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
