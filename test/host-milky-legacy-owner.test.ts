import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const token = "milky-legacy-owner-fixture";
const botId = 99;
const owner = 51;
const outsider = 42;
const otherOwner = 52;
const group = 77;
const unrestrictedGroup = 78;
const time = 1_700_000_000;
const blocked = "私聊只接受资料夹具";
const legacyCommand = "#旧版主人夹具";
const modernCommand = "#原生权限夹具";
const localDiagnostic = "#TodayEatPro20x";
const legacyResult = "V3 主人 true 绑定 false 游戏 sr";

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function mockGateway() {
  const calls: { action: string; body: unknown }[] = [];
  let available = Promise.withResolvers<void>();
  let consumed = 0;
  function success(data: object) {
    return Response.json({ status: "ok", retcode: 0, data });
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response(null, { status: 401 });
      }
      const action = new URL(request.url).pathname.slice("/api/".length);
      calls.push({ action, body: await request.json() });
      available.resolve();
      switch (action) {
        case "get_login_info": return success({ uin: botId, nickname: "V3 夹具" });
        case "send_group_message":
        case "send_private_message": return success({ message_seq: calls.length, time });
        default: return new Response(null, { status: 404 });
      }
    },
  });
  async function next(action: string, body: unknown) {
    if (consumed === calls.length) await deadline(available.promise, `未收到 Milky ${action}。`);
    const call = calls[consumed++]!;
    if (consumed === calls.length) available = Promise.withResolvers<void>();
    expect(call).toEqual({ action, body });
  }
  return {
    server, next,
    reply(target: { group_id: number } | { user_id: number }, text: string | ReturnType<typeof expect.stringMatching>) {
      return next("group_id" in target ? "send_group_message" : "send_private_message", {
        ...target, message: [{ type: "text", data: { text } }],
      });
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
      if (chunk.done) throw new Error("V3 主人测试宿主未启动。\n" + output);
      output += decoder.decode(chunk.value, { stream: true });
    }
    const origin = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
    if (!origin) throw new Error("V3 主人测试宿主未输出 HTTP 监听地址。");
    return new URL("/milky", origin);
  } finally {
    reader.releaseLock();
  }
}

function webhook(endpoint: URL, event_type: string, data: object, self_id = botId, authenticated = true) {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ time, self_id, event_type, data }),
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

function message(text: string, message_seq: number, sender_id: number, groupId?: number) {
  return {
    time, message_seq, sender_id, peer_id: groupId ?? sender_id,
    message_scene: groupId === undefined ? "friend" : "group",
    isMaster: true, boundAccount: true,
    ...(groupId === undefined ? {} : { group_member: { group_id: groupId, user_id: sender_id, role: "owner" } }),
    segments: [{ type: "text", data: { text } }],
  };
}

function nudge(user_id: number) {
  return { user_id, is_self_send: false, is_self_receive: true, display_action: "戳了戳", display_suffix: "", display_action_img_url: "" };
}

test("Milky 当前账号主人可使用 V3 权限，原生命令和统计保留各自限制", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-legacy-owner-"));
  const mock = mockGateway();
  try {
    await copyHost(root);
    const config = join(root, "config", "config");
    const native = join(root, "plugins", "fixture-native-owner");
    const atlas = join(root, "plugins", "atlas");
    await Promise.all([mkdir(config, { recursive: true }), mkdir(native), mkdir(atlas)]);
    await writeFile(join(config, "other.yaml"), [
      'master: ["99:51", "100:52"]', "disablePrivate: true", `disableMsg: ${blocked}`,
    ].join("\n") + "\n");
    await writeFile(join(config, "group.yaml"), [
      "default:", "  groupCD: 0", "  singleCD: 0",
      `"${group}": { onlyReplyAt: 2, botAlias: 夹具 }`,
    ].join("\n") + "\n");
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.url.port}`,
      "connection: webhook", `access_token: ${token}`,
    ].join("\n") + "\n");
    await writeFile(join(native, "package.json"), JSON.stringify({
      name: "fixture-native-owner", lotusYunzai: { entry: "./index.ts" },
    }));
    await writeFile(join(native, "index.ts"), `
      export default { commands: { "${modernCommand}": (_args, ctx) => "原生命令主人 " + ctx.isMaster } };
    `);
    await writeFile(join(atlas, "package.json"), JSON.stringify({
      name: "@lotus-yunzai/atlas", lotusYunzai: { entry: "./index.ts" },
    }));
    await writeFile(join(atlas, "index.ts"), `
      export default {
        commands: { "#检查图鉴更新": (_args, ctx) => "图鉴维护 " + (ctx.atlasMaintenance === true) },
        aliases: { "图鉴检查更新": "#检查图鉴更新", "荷花图鉴检查更新": "#检查图鉴更新" },
      };
    `);
    await writeFile(join(root, "plugins", "milky-owner-fixture.js"), `
      export const apps = {
        commands: class extends plugin {
          constructor() {
            super({ event: "message", rule: [
              { reg: "^${legacyCommand}$", fnc: "run", permission: "master" },
              { reg: "^${localDiagnostic}$", fnc: "diagnose" },
            ] });
          }
          run(e) {
            e.isSr = true;
            return e.reply("V3 主人 " + e.isMaster + " 绑定 " + e.boundAccount + " 游戏 " + e.game);
          }
          diagnose(e) { return e.reply("本机诊断夹具"); }
        },
        poke: class extends plugin {
          constructor() { super({ event: "notice.friend.poke" }); }
          async accept(e) {
            await e.reply("V3 好友戳一戳 " + e.isMaster);
            return "return";
          }
        },
      };
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0" },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const endpoint = await deadline(startup(host.stdout), "V3 主人测试宿主启动超时。");
      await mock.next("get_login_info", {});
      await waitForBind(endpoint);
      let seq = 0;
      async function command(text: string, actor = owner, groupId?: number) {
        expect((await webhook(endpoint, "message_receive", message(text, ++seq, actor, groupId))).status).toBe(200);
      }

      const forged = message(legacyCommand, ++seq, owner);
      expect((await webhook(endpoint, "message_receive", forged, botId, false)).status).toBe(401);
      expect((await webhook(endpoint, "message_receive", message(legacyCommand, ++seq, otherOwner), 100)).status).toBe(403);
      await command(legacyCommand, outsider);
      await mock.reply({ user_id: outsider }, blocked);
      await command(legacyCommand, otherOwner);
      await mock.reply({ user_id: otherOwner }, blocked);
      await command(legacyCommand);
      await mock.reply({ user_id: owner }, legacyResult);

      await command(localDiagnostic, owner, group);
      await command(localDiagnostic, outsider, unrestrictedGroup);
      await command(localDiagnostic, otherOwner);
      await Bun.sleep(1_020);
      await command(localDiagnostic);
      await mock.reply({ user_id: owner }, "本机诊断夹具");

      await Bun.sleep(1_020);
      await command(legacyCommand, owner, group);
      await mock.reply({ group_id: group }, legacyResult);
      await command(legacyCommand, outsider, group);
      await command("#状态", outsider, unrestrictedGroup);
      await mock.reply({ group_id: unrestrictedGroup }, expect.stringMatching(/^Lotus-Yunzai 正在运行/u));
      await command("夹具" + legacyCommand, outsider, group);
      await mock.reply({ group_id: group }, "暂无权限执行此指令。");

      await command(modernCommand);
      await mock.reply({ user_id: owner }, "原生命令主人 false");
      await Bun.sleep(1_020);
      await command(modernCommand, owner, group);
      await mock.reply({ group_id: group }, "原生命令主人 false");
      await command("#统计 机器人 99");
      await mock.reply({ user_id: owner }, "仅当前机器人的主人可以指定统计对象。");
      await command("荷花图鉴检查更新");
      await mock.reply({ user_id: owner }, "图鉴维护 false");
      await command("图鉴检查更新");
      await mock.reply({ user_id: owner }, "图鉴维护 true");
      await command("#检查图鉴更新", owner, group);
      await mock.reply({ group_id: group }, "图鉴维护 true");
      await command("#检查图鉴更新", outsider, unrestrictedGroup);
      await mock.reply({ group_id: unrestrictedGroup }, "图鉴维护 false");
      await command("#检查图鉴更新", otherOwner, unrestrictedGroup);
      await mock.reply({ group_id: unrestrictedGroup }, "图鉴维护 false");

      expect((await webhook(endpoint, "friend_nudge", nudge(outsider))).status).toBe(200);
      await mock.reply({ user_id: outsider }, blocked);
      expect((await webhook(endpoint, "friend_nudge", nudge(owner))).status).toBe(200);
      await mock.reply({ user_id: owner }, "V3 好友戳一戳 true");
      await Bun.sleep(80);
      mock.expectDrained();
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
