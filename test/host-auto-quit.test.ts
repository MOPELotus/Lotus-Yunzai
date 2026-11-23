import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: Readonly<Record<string, unknown>>;
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 2_500);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function connect(endpoint: string, botId?: number) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const headers: Record<string, string> = { Authorization: "Bearer auto-quit-fixture", "X-Client-Role": "Universal" };
  if (botId !== undefined) headers["X-Self-ID"] = String(botId);
  const socket = new BunWebSocket(endpoint, { headers });
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
  const frames: Frame[] = [];
  let available = Promise.withResolvers<void>();
  socket.addEventListener("message", ({ data }) => {
    frames.push(JSON.parse(data));
    available.resolve();
  });
  try {
    await deadline(new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    }), "模拟网关连接超时。");
  } catch (error) {
    socket.close();
    throw error;
  }

  function send(value: object) {
    socket.send(JSON.stringify({ self_id: botId ?? 99, ...value }));
  }

  async function request(action: string, params: object) {
    if (!frames.length) await deadline(available.promise, `未收到 ${action}。`);
    const frame = frames.shift()!;
    if (!frames.length) available = Promise.withResolvers<void>();
    expect(frame).toMatchObject({ action, params });
    return frame;
  }

  return {
    send,
    request,
    closed,
    close: () => socket.close(),
    assertNoPendingFrames: () => expect(frames).toEqual([]),
    receipt(frame: Frame, data: unknown = null, status = "ok", retcode = 0) {
      expect(frame.echo).toBeDefined();
      send({ echo: frame.echo, status, retcode, data });
    },
    async expectNoLeave() {
      send({ post_type: "message", message_type: "private", sub_type: "friend", user_id: 42, message: "#状态" });
      await request("send_msg", {
        message_type: "private", user_id: 42, message: expect.stringContaining("Lotus-Yunzai 正在运行"),
      });
    },
  };
}

type Gateway = Awaited<ReturnType<typeof connect>>;

async function endpointOf(host: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const reader = host.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) throw new Error("测试宿主未启动 OneBot 入口。");
      output += decoder.decode(part.value, { stream: true });
      const endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      if (endpoint) return endpoint;
    }
  } finally {
    reader.releaseLock();
  }
}

async function withHost(run: (open: (botId?: number) => Promise<Gateway>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-auto-quit-"));
  const gateways: Gateway[] = [];
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await writeFile(join(root, "config/config/other.yaml"), 'masterQQ: [52]\nmaster: ["99:51", "100:53"]\n');
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: "auto-quit-fixture" },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const endpoint = await deadline(endpointOf(host), "测试宿主启动超时。");
      await run(async (botId) => {
        const gateway = await connect(endpoint, botId);
        gateways.push(gateway);
        return gateway;
      });
      host.kill();
      await deadline(host.exited, "测试宿主退出超时。");
      for (const gateway of gateways) {
        await deadline(gateway.closed, "测试网关断开超时。");
        gateway.assertNoPendingFrames();
      }
      const diagnostics = await stderr;
      expect(diagnostics).not.toContain("处理 OneBot 来信失败");
      return diagnostics;
    } finally {
      for (const gateway of gateways) gateway.close();
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function joined(groupId: number, time: number, botId = 99) {
  return {
    time, self_id: botId, post_type: "notice", notice_type: "group_increase", sub_type: "invite",
    group_id: groupId, user_id: botId, operator_id: 42,
  };
}

async function groupCount(gateway: Gateway, groupId: number, count: number) {
  const frame = await gateway.request("get_group_info", { group_id: groupId, no_cache: true });
  gateway.receipt(frame, { group_id: groupId, group_name: "样本群", member_count: count, max_member_count: 200 });
}

function member(groupId: number, userId: number, role = "member") {
  return { group_id: groupId, user_id: userId, role };
}

async function members(gateway: Gateway, groupId: number, list: readonly object[]) {
  const frame = await gateway.request("get_group_member_list", { group_id: groupId, no_cache: true });
  gateway.receipt(frame, list);
}

async function botRole(gateway: Gateway, groupId: number, botId: number, role: string, joinTime?: number) {
  const frame = await gateway.request("get_group_member_info", { group_id: groupId, user_id: botId, no_cache: true });
  gateway.receipt(frame, { ...member(groupId, botId, role), join_time: joinTime });
}

async function snapshot(gateway: Gateway, groupId: number, botId: number, otherId: number, lastCount = 2) {
  return snapshotMembers(gateway, groupId, botId, [botId, otherId], lastCount);
}

async function snapshotMembers(gateway: Gateway, groupId: number, botId: number, ids: readonly number[], lastCount = ids.length) {
  await groupCount(gateway, groupId, ids.length);
  await members(gateway, groupId, ids.map(id => member(groupId, id)));
  await botRole(gateway, groupId, botId, "member");
  await groupCount(gateway, groupId, lastCount);
}

async function notice(gateway: Gateway, groupId: number) {
  return gateway.request("send_msg", {
    message_type: "group", group_id: groupId, message: "禁止拉群，已自动退出", auto_escape: true,
  });
}

test("自动退群按真实入群和临界人数判断，并保护主人、群主和异常快照", () => withHost(async (open) => {
  const gateway = await open(99);
  const unbound = await open();
  const now = Math.floor(Date.now() / 1000) - 2;

  unbound.send(joined(72000, now));
  await unbound.expectNoLeave();
  gateway.send({ ...joined(72001, now), user_id: 44 });
  gateway.send(joined(72002, now, 100));
  await gateway.expectNoLeave();

  gateway.send(joined(72011, now));
  await groupCount(gateway, 72011, 51);
  await gateway.expectNoLeave();

  for (const [groupId, owner] of [[72003, 52], [72004, 51]] as const) {
    gateway.send(joined(groupId, now));
    await snapshot(gateway, groupId, 99, owner);
    await gateway.expectNoLeave();
  }

  gateway.send(joined(72005, now));
  await groupCount(gateway, 72005, 2);
  await members(gateway, 72005, [member(72005, 99, "owner"), member(72005, 42)]);
  await botRole(gateway, 72005, 99, "owner");
  await gateway.expectNoLeave();

  gateway.send(joined(72006, now));
  await groupCount(gateway, 72006, 2);
  await members(gateway, 72006, [member(72006, 99), member(72999, 42)]);
  await gateway.expectNoLeave();

  gateway.send(joined(72009, now));
  await groupCount(gateway, 72009, 2);
  await members(gateway, 72009, [member(72009, 99), member(72009, 42)]);
  await botRole(gateway, 72009, 99, "admin");
  await gateway.expectNoLeave();

  gateway.send(joined(72007, now));
  await snapshot(gateway, 72007, 99, 42, 1);
  await gateway.expectNoLeave();

  gateway.send(joined(72010, now));
  await groupCount(gateway, 72010, 2);
  await members(gateway, 72010, [member(72010, 99), member(72010, 42)]);
  await botRole(gateway, 72010, 99, "member", now + 1);
  await gateway.expectNoLeave();

  const eligible = joined(72008, now);
  gateway.send(eligible);
  await snapshotMembers(gateway, eligible.group_id, 99, [99, 53, ...Array.from({ length: 48 }, (_, index) => 1000 + index)]);
  const warning = await notice(gateway, eligible.group_id);
  gateway.assertNoPendingFrames();
  gateway.receipt(warning, { message_id: 805 });
  const leave = await gateway.request("set_group_leave", { group_id: eligible.group_id, is_dismiss: false });
  gateway.send(eligible);
  gateway.receipt(leave);
  gateway.send(eligible);
  await gateway.expectNoLeave();

  const secondBot = await open(100);
  secondBot.send(joined(eligible.group_id, now, 100));
  await snapshot(secondBot, eligible.group_id, 100, 53);
  await secondBot.expectNoLeave();

  const interrupted = joined(72012, now);
  gateway.send(interrupted);
  const pendingCount = await gateway.request("get_group_info", { group_id: interrupted.group_id, no_cache: true });
  const replacement = await open(99);
  await replacement.expectNoLeave();
  gateway.receipt(pendingCount, { group_id: interrupted.group_id, member_count: 2 });
  replacement.send(interrupted);
  await replacement.expectNoLeave();
  gateway.assertNoPendingFrames();
}), 12_000);

test("退群回执未知时不重发，后续真实重新入群可重新判断", async () => {
  const diagnostics = await withHost(async (open) => {
    let gateway = await open(99);
    const time = Math.floor(Date.now() / 1000) - 2;
    const event = joined(72101, time);
    gateway.send(event);
    await snapshot(gateway, event.group_id, 99, 42);
    gateway.receipt(await notice(gateway, event.group_id), null, "failed", 100);
    await gateway.request("set_group_leave", { group_id: event.group_id, is_dismiss: false });
    gateway.close();
    await deadline(gateway.closed, "退群提交后未检测到旧连接关闭。");
    gateway = await open(99);
    gateway.send(event);
    await gateway.expectNoLeave();

    gateway.send({ ...event, time: time + 1, notice_type: "group_decrease", sub_type: "leave" });
    gateway.send(event);
    await gateway.expectNoLeave();

    gateway.send({ ...event, time: time + 2 });
    await snapshot(gateway, event.group_id, 99, 42);
    gateway.receipt(await notice(gateway, event.group_id), { message_id: 806 });
    const second = await gateway.request("set_group_leave", { group_id: event.group_id, is_dismiss: false });
    gateway.receipt(second);
    await gateway.expectNoLeave();
  });
  expect(diagnostics.match(/\[自动退群\].*未确认[^\n]*/gu)).toHaveLength(1);
}, 9_000);
