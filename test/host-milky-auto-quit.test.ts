import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const token = "milky-auto-quit-fixture";
const botId = 99;
const userId = 42;
const unknownWarning = "[自动退群] 协议端未确认退群结果。";

interface Call {
  action: string;
  body: unknown;
  respond: (response: Response) => void;
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function accepted(data: object = {}) {
  return Response.json({ status: "ok", retcode: 0, data });
}

function mockGateway() {
  const calls: Call[] = [];
  let available = Promise.withResolvers<void>();
  let consumed = 0;
  let commands = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response(null, { status: 401 });
      }
      const action = new URL(request.url).pathname.slice("/api/".length);
      const body = await request.json();
      const response = Promise.withResolvers<Response>();
      calls.push({ action, body, respond: response.resolve });
      available.resolve();
      return response.promise;
    },
  });
  return {
    server,
    async next(action: string, body: unknown) {
      if (calls.length === consumed) await deadline(available.promise, `未收到 Milky ${action} 动作。`);
      const call = calls[consumed++]!;
      if (calls.length === consumed) available = Promise.withResolvers<void>();
      expect({ action: call.action, body: call.body }).toEqual({ action, body });
      return call;
    },
    nextMessageId: () => ++commands,
    expectDrained() { expect(calls).toHaveLength(consumed); },
    stop() {
      for (const call of calls) call.respond(new Response(null, { status: 503 }));
      server.stop(true);
    },
  };
}

type Gateway = ReturnType<typeof mockGateway>;

async function startup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Milky 退群测试宿主未启动。\n" + output);
      output += decoder.decode(chunk.value, { stream: true });
    }
    const origin = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
    if (!origin) throw new Error("Milky 退群测试宿主未输出 HTTP 监听地址。");
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

function webhook(endpoint: URL, eventType: string, data: object, time?: number, account = botId) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ self_id: account, time, event_type: eventType, data }),
    signal: AbortSignal.timeout(2_000),
  });
}

async function waitForBind(endpoint: URL) {
  const stopAt = performance.now() + 2_000;
  for (;;) {
    const response = await webhook(endpoint, "fixture_unsupported", {});
    if (response.status !== 503 || performance.now() >= stopAt) {
      expect(response.status).toBe(200);
      return;
    }
    await Bun.sleep(25);
  }
}

async function groupCount(mock: Gateway, groupId: number, count: number) {
  const call = await mock.next("get_group_info", { group_id: groupId, no_cache: true });
  call.respond(accepted({ group: { group_id: groupId, group_name: "退群夹具", member_count: count, max_member_count: 200 } }));
}

function member(groupId: number, id: number, role = "member") {
  return { group_id: groupId, user_id: id, role };
}

async function members(mock: Gateway, groupId: number, values: object[]) {
  const call = await mock.next("get_group_member_list", { group_id: groupId, no_cache: true });
  call.respond(accepted({ members: values }));
}

async function selfMembership(mock: Gateway, groupId: number, role: string, time: number) {
  const call = await mock.next("get_group_member_info", { group_id: groupId, user_id: botId, no_cache: true });
  call.respond(accepted({ member: { ...member(groupId, botId, role), join_time: time } }));
}

async function snapshot(mock: Gateway, groupId: number, other: number, time: number, lastCount = 2) {
  await groupCount(mock, groupId, 2);
  await members(mock, groupId, [member(groupId, botId), member(groupId, other)]);
  await selfMembership(mock, groupId, "member", time);
  await groupCount(mock, groupId, lastCount);
}

async function expectNoLeave(endpoint: URL, mock: Gateway, time: number) {
  const seq = mock.nextMessageId();
  expect((await webhook(endpoint, "message_receive", {
    time, message_scene: "friend", peer_id: userId, sender_id: userId, message_seq: seq,
    segments: [{ type: "text", data: { text: "#退群夹具" } }],
  }, time)).status).toBe(200);
  const call = await mock.next("send_private_message", {
    user_id: userId, message: [{ type: "text", data: { text: "退群夹具正常" } }],
  });
  call.respond(accepted({ message_seq: 100 + seq, time }));
  await Bun.sleep(25);
  mock.expectDrained();
}

test("Milky 自动退群核实实时群信息、保护主人和群主，并按入群时间去重", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-auto-quit-"));
  const mock = mockGateway();
  try {
    await copyHost(root);
    await mkdir(join(root, "config", "config"), { recursive: true });
    await writeFile(join(root, "config", "config", "other.yaml"), [
      "autoQuit: 2", "masterQQ: [52]", 'master: ["99:51", "100:53"]',
    ].join("\n") + "\n");
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.port}`,
      "connection: webhook", `access_token: ${token}`,
    ].join("\n") + "\n");
    await writeFile(join(root, "plugins", "auto-quit-fixture.js"), `
      export default class extends plugin {
        constructor() {
          super({ event: "message.private", rule: [{ reg: "^#退群夹具$", fnc: "probe" }] });
        }
        probe(e) { return e.reply("退群夹具正常"); }
      }
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0" },
    });
    const unknown = Promise.withResolvers<void>();
    const stderr = collectWarnings(host.stderr, unknown.resolve);
    try {
      const endpoint = await deadline(startup(host.stdout), "Milky 退群测试宿主启动超时。");
      (await mock.next("get_login_info", {})).respond(accepted({ uin: botId, nickname: "退群夹具" }));
      await waitForBind(endpoint);
      const time = Math.floor(Date.now() / 1_000) - 5;
      const joinEvent = (group_id: number) => ({ group_id, user_id: botId, invitor_id: userId });
      async function joined(groupId: number, at = time) {
        expect((await webhook(endpoint, "group_member_increase", joinEvent(groupId), at)).status).toBe(200);
      }

      expect((await webhook(endpoint, "group_member_increase", joinEvent(72001), time, 100)).status).toBe(403);
      expect((await webhook(endpoint, "group_member_increase", { ...joinEvent(72002), user_id: userId }, time)).status).toBe(200);
      expect((await webhook(endpoint, "group_member_increase", joinEvent(72003))).status).toBe(200);
      await joined(72004, 0);
      await expectNoLeave(endpoint, mock, time);

      const overThreshold = 72011;
      await joined(overThreshold);
      await groupCount(mock, overThreshold, 3);
      await expectNoLeave(endpoint, mock, time);

      for (const [groupId, owner] of [[72005, 51], [72006, 52]] as const) {
        await joined(groupId);
        await snapshot(mock, groupId, owner, time);
        await expectNoLeave(endpoint, mock, time);
      }

      const botOwnsGroup = 72007;
      await joined(botOwnsGroup);
      await groupCount(mock, botOwnsGroup, 2);
      await members(mock, botOwnsGroup, [member(botOwnsGroup, botId, "owner"), member(botOwnsGroup, userId)]);
      await selfMembership(mock, botOwnsGroup, "owner", time);
      await expectNoLeave(endpoint, mock, time);

      await joined(72008);
      await snapshot(mock, 72008, userId, time, 1);
      await expectNoLeave(endpoint, mock, time);

      const stale = 72009;
      await joined(stale);
      await groupCount(mock, stale, 2);
      await members(mock, stale, [member(stale, botId), member(stale, userId)]);
      await selfMembership(mock, stale, "member", time + 1);
      await expectNoLeave(endpoint, mock, time);

      const eligible = 72010;
      await joined(eligible);
      await snapshot(mock, eligible, 53, time);
      const first = await mock.next("quit_group", { group_id: eligible });
      await joined(eligible);
      await expectNoLeave(endpoint, mock, time);
      first.respond(new Response(null, { status: 503 }));
      await deadline(unknown.promise, "Milky 未记录退群结果未确认。");
      await joined(eligible);
      expect((await webhook(endpoint, "group_member_decrease", joinEvent(eligible), time + 1)).status).toBe(200);
      await expectNoLeave(endpoint, mock, time);

      await joined(eligible, time + 2);
      await snapshot(mock, eligible, 53, time + 2);
      (await mock.next("quit_group", { group_id: eligible })).respond(accepted());
      await joined(eligible, time + 2);
      await expectNoLeave(endpoint, mock, time + 2);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
    }
    const warnings = await stderr;
    expect(warnings.split("\n").filter((line) => line === unknownWarning)).toHaveLength(1);
    expect(warnings).not.toContain(token);
  } finally {
    mock.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
