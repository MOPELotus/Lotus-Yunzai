import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createProcessReceipts } from "../lib/process-receipts.ts";
import { copyHost } from "./host-fixture.ts";

const token = "milky-process-control-fixture";
const botId = 99;
const owner = 51;
const ordinary = 42;
const otherOwner = 52;
const groupId = 77;
const probe = "#进程夹具";
const time = 1_700_000_000;

interface Call {
  action: string;
  body: {
    user_id?: number;
    group_id?: number;
    message: { type: "text"; data: { text: string } }[];
  };
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 3_500);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function mockGateway() {
  const sessions = [Promise.withResolvers<Bun.ServerWebSocket<number>>(), Promise.withResolvers<Bun.ServerWebSocket<number>>()];
  const initialClosed = Promise.withResolvers<void>();
  const calls: Call[] = [];
  let available = Promise.withResolvers<void>();
  let connections = 0;
  let nextMessage = 0;
  const server = Bun.serve<number>({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, gateway) {
      if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/event") {
        if (gateway.upgrade(request, { data: connections++ })) return;
        return new Response(null, { status: 426 });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      switch (pathname) {
        case "/api/get_login_info":
          return Response.json({ status: "ok", retcode: 0, data: { uin: botId, nickname: "进程管理夹具" } });
        case "/api/send_group_message":
        case "/api/send_private_message":
          calls.push({ action: pathname.slice("/api/".length), body: await request.json() as Call["body"] });
          available.resolve();
          return Response.json({ status: "ok", retcode: 0, data: { message_seq: ++nextMessage, time } });
        default:
          return new Response(null, { status: 404 });
      }
    },
    websocket: {
      open(socket) { sessions[socket.data]?.resolve(socket); },
      message() {},
      close(socket) { if (socket.data === 0) initialClosed.resolve(); },
    },
  });
  return {
    server, sessions, initialClosed,
    async next(target: { user_id: number } | { group_id: number }, text: string | ReturnType<typeof expect.stringMatching>) {
      if (!calls.length) await deadline(available.promise, "Milky 未发送进程管理消息。");
      const call = calls.shift()!;
      if (!calls.length) available = Promise.withResolvers<void>();
      expect(call).toMatchObject({
        action: "group_id" in target ? "send_group_message" : "send_private_message",
        body: target,
      });
      expect(call.body.message).toEqual([{ type: "text", data: { text } }]);
      return call.body.message[0]!.data.text;
    },
    expectSilence() { expect(calls).toEqual([]); },
  };
}

function commands(socket: Bun.ServerWebSocket<number>) {
  let message_seq = 0;
  return (text: string, sender_id = owner, group?: number) => socket.send(JSON.stringify({
    time, self_id: botId, event_type: "message_receive",
    data: {
      time, message_seq: ++message_seq, sender_id, peer_id: group ?? sender_id,
      message_scene: group === undefined ? "friend" : "group", segments: [{ type: "text", data: { text } }],
    },
  }));
}

test.skipIf(process.platform !== "linux")("Milky 主人可软停启、同 PID 重启和停机，回执返回原会话", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-process-control-"));
  const mock = mockGateway();
  try {
    await copyHost(root);
    await mkdir(join(root, "config", "config"), { recursive: true });
    await writeFile(join(root, "config", "config", "other.yaml"), `master: ["${botId}:${owner}", "100:${otherOwner}"]\n`);
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.port}`,
      `access_token: ${token}`, "ws:", "  reconnect_interval: 0.05",
    ].join("\n") + "\n");
    await writeFile(join(root, "plugins", "milky-process-fixture.js"), `
      const startup = crypto.randomUUID();
      export default class extends plugin {
        constructor() { super({ event: "message", rule: [{ reg: "^${probe}( [0-9]+)?$", fnc: "report" }] }); }
        report(e) {
          return e.reply(JSON.stringify({ pid: process.pid, startup, isMaster: e.isMaster, boundAccount: e.boundAccount }));
        }
      }
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH },
    });
    const stdout = new Response(host.stdout).text();
    const stderr = new Response(host.stderr).text();
    try {
      const first = commands(await deadline(mock.sessions[0]!.promise, "Milky 未建立初始连接。"));
      const ownerTarget = { user_id: owner };
      let probeNumber = 0;
      async function verifyProcess(command: typeof first) {
        command(`${probe} ${++probeNumber}`);
        const value = JSON.parse(await mock.next(ownerTarget, expect.any(String)));
        expect(value).toEqual({ pid: host.pid, startup: expect.any(String), isMaster: true, boundAccount: false });
        return value.startup as string;
      }
      const originalBoot = await verifyProcess(first);
      first(probe, ordinary);
      expect(JSON.parse(await mock.next({ user_id: ordinary }, expect.any(String))))
        .toEqual({ pid: host.pid, startup: originalBoot, isMaster: false, boundAccount: false });

      for (const text of ["#关机", "#重启", "#停机"]) {
        first(text, ordinary);
        await mock.next({ user_id: ordinary }, "暂无权限，只有主人才能操作");
      }
      first("#重启", otherOwner, groupId);
      await mock.next({ group_id: groupId }, "暂无权限，只有主人才能操作");
      expect(await verifyProcess(first)).toBe(originalBoot);

      first("#关机");
      await mock.next(ownerTarget, expect.stringMatching(/^关机成功，本次运行时长/u));
      first(probe);
      first("#开机", ordinary);
      first("#开机", otherOwner);
      await Bun.sleep(100);
      mock.expectSilence();
      first("#开机");
      await mock.next(ownerTarget, expect.stringMatching(/^开机成功，距离上次关机/u));
      expect(await verifyProcess(first)).toBe(originalBoot);

      first("#重启", owner, groupId);
      await mock.next({ group_id: groupId }, expect.stringMatching(/^开始重启/u));
      await deadline(mock.initialClosed.promise, "Milky 原连接在重启时未关闭。");
      const resumed = commands(await deadline(mock.sessions[1]!.promise, "Milky 重启后未重新连接。"));
      await mock.next({ group_id: groupId }, expect.stringMatching(/^重启成功，用时/u));
      expect(await verifyProcess(resumed)).not.toBe(originalBoot);

      resumed("#停止");
      await mock.next(ownerTarget, expect.stringMatching(/^开始停止/u));
      expect(await deadline(host.exited, "Milky 停机后宿主未退出。")).toBe(0);
      const receipt = await createProcessReceipts(pathToFileURL(root + "/")).take(botId, "milky");
      expect(receipt).toMatchObject({
        kind: "stop", target: { adapter: "milky", type: "private", botId, id: owner },
      });
      expect((await stdout).match(/Lotus-Yunzai 已启动/gu)).toHaveLength(2);
      expect(await stderr).not.toMatch(/未确认进程操作回执|未确认进程操作开始通知/u);
      mock.expectSilence();
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
    }
  } finally {
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 14_000);

test("旧托管器下 Milky 主人可查看安装目录，更新和安装给出升级提示", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-old-supervisor-"));
  const mock = mockGateway();
  try {
    await copyHost(root);
    await mkdir(join(root, "config", "config"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "config", "config", "other.yaml"), [
        `master: ["${botId}:${owner}", "100:${otherOwner}"]`, "disablePrivate: true", "disableMsg: 私聊已禁用", "",
      ].join("\n")),
      writeFile(join(root, "config", "milky.yaml"), [
        "enable: true", "host: 127.0.0.1", `port: ${mock.server.port}`, `access_token: ${token}`, "",
      ].join("\n")),
      writeFile(join(root, "config", "install.yaml"), JSON.stringify({
        plugins: { "隔离插件": {
          url: "https://example.invalid/fixtures/milky.git", directory: "managed-fixture", branch: "main", revision: "a".repeat(40),
        } },
      })),
    ]);
    const ipc: { type?: string }[] = [];
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "ignore", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_MANAGED_TOKEN: crypto.randomUUID() },
      ipc(message: { type?: string }) { ipc.push(message); },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const command = commands(await deadline(mock.sessions[0]!.promise, "旧托管器夹具未建立 Milky 连接。"));
      const ownerTarget = { user_id: owner };
      const upgrade = "当前托管器版本不支持 Milky 更新或安装。请在终端重启 bun run start 后重试。";
      command("#安装插件");
      await mock.next(ownerTarget, expect.stringMatching(/可安装插件列表：[\s\S]*隔离插件/u));
      command("#更新");
      await mock.next(ownerTarget, upgrade);
      command("#安装隔离插件");
      await mock.next(ownerTarget, upgrade);
      command("#更新", otherOwner, groupId);
      await mock.next({ group_id: groupId }, "暂无权限，只有主人才能操作");
      command("#更新", ordinary);
      await mock.next({ user_id: ordinary }, "私聊已禁用");
      command("#更新日志", otherOwner);
      await mock.next({ user_id: otherOwner }, "私聊已禁用");
      command("#更新日志");
      await mock.next(ownerTarget, "暂无可用的更新日志。");
      expect(ipc.map(({ type }) => type)).toContain("lotus-ready");
      expect(ipc.map(({ type }) => type)).not.toContain("lotus-update");
      host.kill("SIGTERM");
      expect(await deadline(host.exited, "旧托管器夹具未退出。")).toBe(143);
      expect(await stderr).not.toMatch(/未能完成启动交接/u);
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
    }
  } finally {
    mock.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
