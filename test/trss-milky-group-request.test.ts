import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost } from "./host-fixture.ts";

const token = "milky-group-request-fixture";
const account = 99;
const owner = 51;
const outsider = 42;
const invitee = 43;
const time = 1_700_000_000;
const autoGroup = 70101;
const pendingInviteGroup = 70102;
const directGroup = 70103;
const indirectGroup = 70104;
const unknownGroup = 70105;

interface Call {
  action: string;
  body: unknown;
}

function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), 3_000);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function mockGateway() {
  let ready = Promise.withResolvers<void>();
  const calls: Call[] = [];
  let handled = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response(null, { status: 401 });
      }
      const action = new URL(request.url).pathname.slice("/api/".length);
      const body = await request.json() as Record<string, unknown>;
      calls.push({ action, body });
      ready.resolve();
      switch (action) {
        case "get_login_info":
          return Response.json({ status: "ok", retcode: 0, data: { uin: account, nickname: "入群审批夹具" } });
        case "send_private_message":
          return Response.json({ status: "ok", retcode: 0, data: { message_seq: 100 + calls.length, time } });
        case "accept_group_invitation":
          if (body.group_id === unknownGroup) return new Response(null, { status: 503 });
          return Response.json({ status: "ok", retcode: 0, data: {} });
        case "accept_group_request":
        case "reject_group_request":
          return Response.json({ status: "ok", retcode: 0, data: {} });
        default:
          return new Response(null, { status: 404 });
      }
    },
  });
  return {
    server, calls,
    get consumed() { return handled; },
    async next(action: string) {
      if (handled === calls.length) await deadline(ready.promise, `未收到 Milky ${action} 请求。`);
      const call = calls[handled++]!;
      if (handled === calls.length) ready = Promise.withResolvers<void>();
      expect(call.action).toBe(action);
      return call.body;
    },
  };
}

type Gateway = ReturnType<typeof mockGateway>;
type TextSegment = { type: "text"; data: { text: string } };

async function privateText(mock: Gateway, userId = owner): Promise<string> {
  const body = await mock.next("send_private_message") as { user_id: number; message: TextSegment[] };
  expect(body).toEqual({
    user_id: userId, message: [{ type: "text", data: { text: expect.any(String) } }],
  });
  return body.message[0]!.data.text;
}

async function manualId(mock: Gateway, group: number) {
  const notice = await privateText(mock);
  expect(notice).toContain("【待审核群请求】");
  expect(notice).toContain(`群 ${group}`);
  const id = /#同意入群 ([a-f0-9]{12})/u.exec(notice)?.[1];
  expect(id).toBeDefined();
  return { id: id!, notice };
}

async function startup(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.includes("Lotus-Yunzai 已启动")) {
      const part = await reader.read();
      if (part.done) throw new Error("Milky 群审批宿主未启动。\n" + output);
      output += decoder.decode(part.value, { stream: true });
    }
    const origin = /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1];
    if (!origin) throw new Error("Milky 群审批宿主未输出 HTTP 监听地址。");
    return new URL("/milky", origin);
  } finally {
    reader.releaseLock();
  }
}

function webhook(endpoint: URL, type: string, data: object, selfId = account, authenticated = true) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
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

function invitation(group_id: number, invitation_seq: number, initiator_id = owner) {
  return { group_id, invitation_seq, initiator_id };
}

function commandMessage(text: string, message_seq: number, sender_id = owner) {
  return {
    time, message_seq, message_scene: "friend", peer_id: sender_id, sender_id,
    segments: [{ type: "text", data: { text } }],
  };
}

test("Milky 只自动通过主人邀请机器人入群，其他群申请由当前主人审核", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-group-request-"));
  const mock = mockGateway();
  try {
    await copyHost(root);
    await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins", "group"), {
      recursive: true, filter: (path) => !path.endsWith("/.git"),
    });
    await mkdir(join(root, "config", "config"), { recursive: true });
    await writeFile(join(root, "config", "config", "other.yaml"), "autoGroup: 0\ndisablePrivate: true\ndisableMsg: 私聊关闭\n" +
      `master: ["${account}:${owner}","100:52"]\n`);
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${mock.server.port}`,
      "connection: webhook", `access_token: ${token}`,
    ].join("\n") + "\n");
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0" },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const endpoint = await deadline(startup(host.stdout), "Milky 群审批宿主启动超时。");
      expect(await mock.next("get_login_info")).toEqual({});
      await waitForBind(endpoint);
      let sequence = 0;
      async function command(text: string, userId = owner) {
        expect((await webhook(endpoint, "message_receive", commandMessage(text, ++sequence, userId))).status).toBe(200);
      }

      const automatic = invitation(autoGroup, 101);
      expect((await webhook(endpoint, "group_invitation", automatic, account, false)).status).toBe(401);
      expect((await webhook(endpoint, "group_invitation", automatic, account + 1)).status).toBe(403);
      expect((await webhook(endpoint, "group_invitation", automatic)).status).toBe(200);
      expect(await mock.next("accept_group_invitation")).toEqual({ group_id: autoGroup, invitation_seq: 101 });
      expect(await privateText(mock)).toContain(`已同意加群：${autoGroup}`);
      expect((await webhook(endpoint, "group_invitation", automatic)).status).toBe(200);

      expect((await webhook(endpoint, "group_invitation", invitation(pendingInviteGroup, 102, outsider))).status).toBe(200);
      const outsiderInvite = await manualId(mock, pendingInviteGroup);
      expect(outsiderInvite.notice).toContain(`邀请者 ${outsider}`);

      expect((await webhook(endpoint, "group_join_request", {
        group_id: directGroup, initiator_id: owner, notification_seq: 103, is_filtered: true, comment: "申请夹具",
      })).status).toBe(200);
      const direct = await manualId(mock, directGroup);
      expect(direct.notice).toContain(`申请人 ${owner}`);
      expect(direct.notice).toContain("附言：申请夹具");

      expect((await webhook(endpoint, "group_invited_join_request", {
        group_id: indirectGroup, initiator_id: owner, target_user_id: invitee, notification_seq: 104,
      })).status).toBe(200);
      const indirect = await manualId(mock, indirectGroup);
      expect(indirect.notice).toContain(`申请人 ${invitee} · 邀请者 ${owner}`);

      const ownerApproval = commandMessage(`#同意入群 ${direct.id}`, ++sequence);
      expect((await webhook(endpoint, "message_receive", ownerApproval, account, false)).status).toBe(401);
      expect((await webhook(endpoint, "message_receive", ownerApproval, account + 1)).status).toBe(403);
      await command(`#同意入群 ${direct.id}`, outsider);
      expect(await privateText(mock, outsider)).toBe("私聊关闭");
      await command(`#拒绝入群 ${indirect.id} 不接收他人邀请`, 52);
      expect(await privateText(mock, 52)).toBe("私聊关闭");

      await command("#状态 机器人 99");
      expect(await privateText(mock)).toBe("仅当前机器人的主人可以指定统计对象。");

      await command(`#同意入群 ${direct.id}`);
      expect(await mock.next("accept_group_request")).toEqual({
        group_id: directGroup, notification_seq: 103, notification_type: "join_request", is_filtered: true,
      });
      expect(await privateText(mock)).toBe("已同意群请求。");
      await command(`#拒绝入群 ${indirect.id} 不接收他人邀请`);
      expect(await mock.next("reject_group_request")).toEqual({
        group_id: indirectGroup, notification_seq: 104, notification_type: "invited_join_request",
        is_filtered: false, reason: "不接收他人邀请",
      });
      expect(await privateText(mock)).toBe("已拒绝群请求。");

      const unknown = invitation(unknownGroup, 105);
      expect((await webhook(endpoint, "group_invitation", unknown)).status).toBe(200);
      expect(await mock.next("accept_group_invitation")).toEqual({ group_id: unknownGroup, invitation_seq: 105 });
      const warning = await privateText(mock);
      expect(warning).toContain(String(unknownGroup));
      expect(warning).toMatch(/未确认|无法确认/u);
      expect((await webhook(endpoint, "group_invitation", unknown)).status).toBe(200);
      await command("#入群申请");
      const pending = await privateText(mock);
      expect(pending).toContain(outsiderInvite.id);
      expect(pending).not.toContain(direct.id);
      expect(pending).not.toContain(indirect.id);
      expect(pending).not.toContain(String(unknownGroup));
      await Bun.sleep(80);
      expect(mock.calls).toHaveLength(mock.consumed);
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
