import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const token = "milky-recall-fixture";
const botId = 99;
const owner = 51;
const outsider = 42;
const otherOwner = 52;
const groupId = 77;
const legacyGroup = 78;
const time = 1_700_000_000;
const legacyPrivateSequence = 301;
const rejectedSequence = 402;
const unknownSequence = 502;

interface Call {
  action: string;
  body: Record<string, unknown>;
}

type Target = { group_id: number } | { user_id: number };

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function mockGateway() {
  const calls: Call[] = [];
  let available = Promise.withResolvers<void>();
  let consumed = 0;
  function success(data: object = {}) {
    return Response.json({ status: "ok", retcode: 0, data });
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response(null, { status: 401 });
      }
      const action = new URL(request.url).pathname.slice("/api/".length);
      const body = await request.json() as Call["body"];
      calls.push({ action, body });
      available.resolve();
      switch (action) {
        case "get_login_info": return success({ uin: botId, nickname: "撤回夹具" });
        case "send_group_message":
        case "send_private_message": return success({ message_seq: 1_000 + calls.length, time });
        case "recall_group_message":
        case "recall_private_message":
          if (body.message_seq === rejectedSequence) {
            return Response.json({ status: "failed", retcode: -404, message: "夹具明确拒绝撤回" });
          }
          if (body.message_seq === unknownSequence) return new Response(null, { status: 503 });
          return success();
        default: return new Response(null, { status: 404 });
      }
    },
  });
  async function next(action: string) {
    if (consumed === calls.length) await deadline(available.promise, `未收到 Milky ${action} 动作。`);
    const call = calls[consumed++]!;
    if (consumed === calls.length) available = Promise.withResolvers<void>();
    expect(call.action).toBe(action);
    return call.body;
  }
  return {
    server, next,
    async reply(target: Target, text: string | ReturnType<typeof expect.stringMatching>) {
      const body = await next("group_id" in target ? "send_group_message" : "send_private_message");
      expect(body).toEqual({ ...target, message: [{ type: "text", data: { text } }] });
    },
    async recall(target: Target, ...sequences: number[]) {
      const action = "group_id" in target ? "recall_group_message" : "recall_private_message";
      const observed: number[] = [];
      for (const _ of sequences) {
        const body = await next(action);
        expect(body).toEqual({ ...target, message_seq: expect.any(Number) });
        observed.push(body.message_seq as number);
      }
      expect(observed.sort((a, b) => a - b)).toEqual(sequences);
    },
    expectDrained() { expect(calls).toHaveLength(consumed); },
  };
}

async function startup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Milky 撤回测试宿主未启动。\n" + output);
      output += decoder.decode(chunk.value, { stream: true });
    }
    const origin = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
    if (!origin) throw new Error("Milky 撤回测试宿主未输出 HTTP 监听地址。");
    return new URL("/milky", origin);
  } finally {
    reader.releaseLock();
  }
}

function webhook(endpoint: URL, type: string, data: object, selfId = botId) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ time, self_id: selfId, event_type: type, data }),
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

function message(text: string, message_seq: number, sender_id: number, group?: number, quoted?: number) {
  return {
    time, message_seq, sender_id, peer_id: group ?? sender_id,
    message_scene: group === undefined ? "friend" : "group",
    segments: [
      ...(quoted === undefined ? [] : [{
        type: "reply", data: { message_seq: quoted, sender_id: outsider, time, segments: [] },
      }]),
      { type: "text", data: { text } },
    ],
  };
}

test("Milky 主人撤回按原会话处理命令和引用，保留 V3 优先与回执语义", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-recall-"));
  const mock = mockGateway();
  try {
    await copyHost(root);
    await mkdir(join(root, "config", "config"), { recursive: true });
    await writeFile(join(root, "config", "config", "other.yaml"), [
      'master: ["99:51", "100:52"]', "disablePrivate: true", "disableMsg: 私聊限制夹具",
    ].join("\n") + "\n");
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.url.port}`,
      "connection: webhook", `access_token: ${token}`,
    ].join("\n") + "\n");
    await writeFile(join(root, "plugins", "legacy-recall-fixture.js"), `
      export default class extends plugin {
        constructor() { super({ event: "message", rule: [{ reg: /^#?撤回$/, fnc: "recall" }] }); }
        recall(e) {
          if (e.group_id !== ${legacyGroup} && (!e.isPrivate || e.message_id !== ${legacyPrivateSequence})) return false;
          return e.reply("旧插件处理撤回 " + e.isMaster + " " + e.boundAccount);
        }
      }
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0" },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const endpoint = await deadline(startup(host.stdout), "Milky 撤回测试宿主启动超时。");
      expect(await mock.next("get_login_info")).toEqual({});
      await waitForBind(endpoint);
      const groupTarget = { group_id: groupId };
      const privateTarget = { user_id: owner };
      const legacyReply = "旧插件处理撤回 true false";
      let statusSequence = 900;
      // 撤回重放要经过撤回入口本身的一次性检查。
      const afterDuplicateWindow = () => Bun.sleep(1_050);
      async function send(value: ReturnType<typeof message>) {
        expect((await webhook(endpoint, "message_receive", value)).status).toBe(200);
      }
      async function barrier() {
        const probe = ++statusSequence;
        await send(message("#状态", probe, probe, groupId));
        await mock.reply(groupTarget, expect.stringMatching(/^Lotus-Yunzai 正在运行/u));
        await Bun.sleep(40);
        mock.expectDrained();
      }

      const foreign = message("#撤回", 100, owner, groupId, 101);
      expect((await webhook(endpoint, "message_receive", foreign, botId + 1)).status).toBe(403);
      await send(message("#撤回", 102, outsider, groupId, 103));
      await send(message("#撤回", 104, otherOwner, groupId, 105));
      await send(message("#撤回", 106, outsider));
      await mock.reply({ user_id: outsider }, "私聊限制夹具");
      await send(message("#撤回 多余参数", 107, owner));
      await barrier();

      await send(message("#撤回", 200, owner, legacyGroup, 201));
      await mock.reply({ group_id: legacyGroup }, legacyReply);
      await send(message("撤回", legacyPrivateSequence, owner, undefined, 302));
      await mock.reply(privateTarget, legacyReply);
      await barrier();

      await afterDuplicateWindow();
      const original = message("#撤回", 310, owner, groupId);
      await send(original);
      await mock.recall(groupTarget, 310);
      await barrier();
      await afterDuplicateWindow();
      await send(original);
      await barrier();

      await send(message("撤回", 320, owner, undefined, 321));
      await mock.recall(privateTarget, 320, 321);
      await barrier();
      await afterDuplicateWindow();
      await send(message("#撤回", 330, owner, groupId, 330));
      await mock.recall(groupTarget, 330);
      await barrier();

      await afterDuplicateWindow();
      await send(message("#撤回", 401, owner, groupId, rejectedSequence));
      await mock.recall(groupTarget, 401, rejectedSequence);
      await mock.reply(groupTarget, "已撤回 1 条，其余消息未能撤回。");
      const uncertain = message("撤回", 501, owner, undefined, unknownSequence);
      await send(uncertain);
      await mock.recall(privateTarget, 501, unknownSequence);
      await mock.reply(privateTarget, "已撤回 1 条，其余撤回结果未确认。");
      await afterDuplicateWindow();
      await send(uncertain);
      await barrier();
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
    }
    expect(await stderr).not.toContain(token);
  } finally {
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
