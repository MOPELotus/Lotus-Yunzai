import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

interface Frame {
  readonly action: string;
  readonly echo?: string;
  readonly params: Readonly<Record<string, unknown>>;
}

const owner = 51;
const inviter = 42;

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 2_500);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function connect(endpoint: string, botId: number | null = 99) {
  const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const headers: Record<string, string> = { Authorization: "Bearer group-invitations-fixture", "X-Client-Role": "Universal" };
  if (botId !== null) headers["X-Self-ID"] = String(botId);
  const socket = new BunWebSocket(endpoint, { headers });
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
  const frames: Frame[] = [];
  let frameReady = Promise.withResolvers<void>();
  socket.addEventListener("message", ({ data }) => {
    frames.push(JSON.parse(data));
    frameReady.resolve();
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
  async function take() {
    if (!frames.length) await deadline(frameReady.promise, "没有收到预期的 OneBot 动作。");
    const frame = frames.shift()!;
    if (!frames.length) frameReady = Promise.withResolvers<void>();
    return frame;
  }

  return {
    send,
    take,
    closed,
    close: () => socket.close(),
    assertNoPendingFrames: () => expect(frames).toEqual([]),
    command(message: string) {
      send({ post_type: "message", message_type: "private", sub_type: "friend", user_id: owner, message });
      return take();
    },
    receipt(frame: Frame, status = "ok", retcode = 0) {
      expect(frame.echo).toBeDefined();
      send({ echo: frame.echo, status, retcode });
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

async function withHost(config: { legacy?: string; primary?: string },
  run: (connectGateway: (botId?: number | null) => Promise<Gateway>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-group-invitations-"));
  const gateways: Gateway[] = [];
  try {
    await copyHost(root);
    await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins/group"), {
      recursive: true, filter: (path) => !path.endsWith("/.git"),
    });
    await mkdir(join(root, "config/config"), { recursive: true });
    const masters = `master: ["99:${owner}"]\n`;
    if (config.legacy !== undefined) await writeFile(join(root, "config/config/other.yaml"), masters + config.legacy);
    if (config.primary !== undefined) await writeFile(join(root, "config/other.yaml"), masters + config.primary);
    await writeFile(join(root, "config/group.yaml"), '70110: {disable: [invite]}\n');
    await writeFile(join(root, "plugins/invitation-fixture.js"), `
      export default class InvitationFixture extends plugin {
        constructor() { super({ event: "request.group.invite", priority: 1 }); }
        async accept(e) {
          if (e.comment !== "由旧插件处理") return false;
          if (await e.approve(false, "拒绝样本")) return "return";
          return false;
        }
      }
    `);

    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: "group-invitations-fixture" },
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

function groupRequest(flag: string, groupId: number, userId = inviter, subType = "invite") {
  return { post_type: "request", request_type: "group", sub_type: subType, user_id: userId, group_id: groupId, flag };
}

function privateText(frame: Frame, userId = owner): string {
  expect(frame).toMatchObject({ action: "send_msg", params: { user_id: userId, message_type: "private" } });
  expect(frame.params.group_id).toBeUndefined();
  expect(typeof frame.params.message).toBe("string");
  return frame.params.message as string;
}

function approval(frame: Frame, flag: string) {
  expect(frame).toMatchObject({
    action: "set_group_add_request", params: { flag, sub_type: "invite", approve: true, reason: "" },
  });
}

async function takeManual(gateway: Gateway, groupId: number, flag: string) {
  const frame = await gateway.take();
  const text = privateText(frame);
  expect(text).toContain(`群 ${groupId}`);
  expect(text).not.toContain(flag);
  const id = /#同意入群 ([a-f0-9]{12})/u.exec(text)?.[1];
  expect(id).toBeDefined();
  gateway.receipt(frame);
  return id!;
}

async function takeConfirmation(gateway: Gateway, groupId: number, recipient: number, flag: string) {
  const frame = await gateway.take();
  const text = privateText(frame, recipient);
  expect(text).toContain("已同意加群");
  expect(text).toContain(String(groupId));
  expect(text).not.toContain(flag);
  if (frame.echo !== undefined) gateway.receipt(frame);
}

test.each([
  { label: "新配置保留手审", primary: "", approvesOwner: false },
  { label: "旧配置缺省只同意主人", legacy: "", approvesOwner: true },
  { label: "旧字符串 1 只同意主人", legacy: "autoGroup: '1'\n", approvesOwner: true },
  { label: "主配置可显式关闭旧默认", primary: "autoGroup: false\n", legacy: "autoGroup: 1\n", approvesOwner: false },
])("autoGroup $label", async ({ approvesOwner, ...config }) => {
  await withHost(config, async (connectGateway) => {
    const gateway = await connectGateway();
    gateway.send(groupRequest("other-manual-invite", 70001));
    const inviteId = await takeManual(gateway, 70001, "other-manual-invite");

    gateway.send(groupRequest("owner-member-application", 70002, owner, "add"));
    const addId = await takeManual(gateway, 70002, "owner-member-application");
    const initial = privateText(await gateway.command("#入群申请"));
    expect(initial).toContain(inviteId);
    expect(initial).toContain(addId);
    expect(initial).toContain("成员申请入群");

    const invitation = groupRequest("owner-approved-invite", 70003, owner);
    gateway.send(invitation);
    if (!approvesOwner) {
      await takeManual(gateway, 70003, invitation.flag);
      return;
    }
    const action = await gateway.take();
    approval(action, invitation.flag);
    gateway.send(invitation);
    gateway.receipt(action);
    await takeConfirmation(gateway, 70003, owner, invitation.flag);
    gateway.send(invitation);
    await Bun.sleep(1_020);
    const pending = privateText(await gateway.command("#入群申请"));
    expect(pending).toContain(inviteId);
    expect(pending).toContain(addId);
    expect(pending).not.toContain("70003");
  });
}, 9_000);

test("autoGroup 开启后按回执确认、转手审或提示风险，重复邀请不会重发", async () => {
  const diagnostics = await withHost({ primary: "disablePrivate: false\n", legacy: "autoGroup: 1\nblackGroup: [70108]\nblackUser: [44]\n" }, async (connectGateway) => {
    const gateway = await connectGateway();
    const unbound = await connectGateway(null);
    unbound.send(groupRequest("unbound", 70106, owner));
    gateway.send({ ...groupRequest("different-bot", 70111, owner), self_id: 100 });
    gateway.send(groupRequest("blocked-user", 70107, 44));
    gateway.send(groupRequest("blocked-group", 70108, owner));
    gateway.send(groupRequest("disabled-automatic-feature", 70110));
    await takeManual(gateway, 70110, "disabled-automatic-feature");
    const legacy = groupRequest("legacy-resolved-invite", 70100);
    gateway.send({ ...legacy, comment: "由旧插件处理" });
    const takeover = await gateway.take();
    expect(takeover).toMatchObject({ action: "set_group_add_request", params: {
      flag: legacy.flag, sub_type: "invite", approve: false, reason: "拒绝样本",
    } });
    gateway.receipt(takeover);
    const pendingAfterPlugin = privateText(await gateway.command("#入群申请"));
    expect(pendingAfterPlugin).toContain("70110");
    expect(pendingAfterPlugin).not.toMatch(/70100|70106|70107|70108|70111/u);

    const confirmed = groupRequest("ordinary-approved-invite", 70101);
    gateway.send(confirmed);
    const accepted = await gateway.take();
    approval(accepted, confirmed.flag);
    gateway.send(confirmed);
    gateway.receipt(accepted);
    await takeConfirmation(gateway, 70101, inviter, confirmed.flag);
    gateway.send(confirmed);

    const ordinary = groupRequest("ordinary-member-application", 70105, inviter, "add");
    gateway.send(ordinary);
    const addId = await takeManual(gateway, 70105, ordinary.flag);

    const declined = groupRequest("declined-auto-invite", 70102);
    gateway.send(declined);
    const rejected = await gateway.take();
    approval(rejected, declined.flag);
    gateway.receipt(rejected, "failed", 1403);
    const failedId = await takeManual(gateway, 70102, declined.flag);
    gateway.send(declined);

    const asyncInvite = groupRequest("async-unconfirmed-invite", 70103);
    gateway.send(asyncInvite);
    const asyncAction = await gateway.take();
    approval(asyncAction, asyncInvite.flag);
    gateway.receipt(asyncAction, "async", 1);
    const alert = await gateway.take();
    const warning = privateText(alert);
    expect(warning).toContain("70103");
    expect(warning).toMatch(/未确认|无法确认/u);
    expect(warning).not.toContain(asyncInvite.flag);
    expect(warning).not.toContain("#同意入群");
    if (alert.echo !== undefined) gateway.receipt(alert);
    gateway.send(asyncInvite);
    await Bun.sleep(1_020);
    const pending = privateText(await gateway.command("#入群申请"));
    expect(pending).toContain(failedId);
    expect(pending).toContain(addId);
    expect(pending).not.toMatch(/70100|70101|70103/u);

    const disconnected = groupRequest("disconnected-unconfirmed-invite", 70104);
    gateway.send(disconnected);
    approval(await gateway.take(), disconnected.flag);
    gateway.close();
    await deadline(gateway.closed, "模拟网关断线超时。");

    const reconnected = await connectGateway();
    reconnected.send(disconnected);
    await Bun.sleep(1_020);
    const afterReconnect = privateText(await reconnected.command("#入群申请"));
    expect(afterReconnect).toContain(failedId);
    expect(afterReconnect).not.toMatch(/70101|70103|70104/u);
    const manual = await reconnected.command(`#同意入群 ${failedId}`);
    approval(manual, declined.flag);
    reconnected.receipt(manual);
    expect(privateText(await reconnected.take())).toBe("已同意群请求。");
  });
  expect(diagnostics).toContain("自动审批结果未确认，未能通知主人");
  expect(diagnostics).not.toMatch(/(?:async|disconnected)-unconfirmed-invite/u);
}, 9_000);
