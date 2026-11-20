import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "mention-like-fixture";
const group = 77;
const sender = 51;
const target = 42;
type Action = { action: string; params: Record<string, unknown> };

function textOf({ params }: Action): string {
  const message = params.message;
  if (typeof message === "string") return message;
  return Array.isArray(message) ? message.map(part => part.type === "text" ? part.data.text : "").join("") : "";
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(15);
  }
  throw new Error(label);
}

test("双协议只给当前群经验证的 @ 成员送赞，覆盖旧群功能名与多目标拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-mention-like-wire-"));
  const milkyCalls: Action[] = [];
  const milky = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const action = new URL(request.url).pathname.split("/").at(-1)!;
      const params = await request.json() as Record<string, unknown>;
      milkyCalls.push({ action, params });
      const data = action === "get_login_info" ? { uin: 100 }
        : action === "get_group_member_info" ? { member: { group_id: params.group_id, user_id: params.user_id, role: "member" } }
          : action === "get_friend_info" ? { friend: { user_id: params.user_id } } : { message_seq: 1 };
      return Response.json({ status: "ok", retcode: 0, data });
    },
  });
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let socket: WebSocket | undefined;
  try {
    await copyHost(root);
    await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins", "group"), {
      recursive: true, filter: path => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
    });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/group.yaml"), [
      "enable: true", "count: 3", "strangeThumbUp: false", 'successMsg: "{{at}} {{userId}} 收到 {{thumbUpNum}} 次"',
      'failsMsg: "当前点赞失败"', 'noFriendMsg: "当前账号无法评价该资料卡"',
      'default: {groupCD: 0, singleCD: 0}', '78: {disable: [椰奶点赞]}',
    ].join("\n"));
    await writeFile(join(root, "config/milky.yaml"),
      `enable: true\nhost: 127.0.0.1\nport: ${milky.port}\nconnection: webhook\naccess_token: ${token}\n`);
    disableMemberPrewarm(root);
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    const decoder = new TextDecoder();
    let startup = "";
    void host.stdout.pipeTo(new WritableStream({ write(chunk) { startup += decoder.decode(chunk, { stream: true }); } }));
    const endpoint = await waitFor(() => /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(startup)?.[0], "OneBot 点赞测试宿主未就绪。");
    const http = await waitFor(() => /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(startup)?.[1], "HTTP 监听未就绪。");
    const WebSocketWithHeaders = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const client = socket = new WebSocketWithHeaders(endpoint, {
      headers: { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99" },
    });
    const oneBotCalls: Action[] = [];
    client.onmessage = ({ data }) => {
      const { action, params, echo } = JSON.parse(data);
      oneBotCalls.push({ action, params });
      if (!echo) return;
      const value = action === "get_group_member_info"
        ? { group_id: params.user_id === target ? group : 12345, user_id: params.user_id, role: "member" }
        : action === "get_friend_list" ? [{ user_id: target }] : { message_id: 4 };
      client.send(JSON.stringify({ echo, status: "ok", retcode: 0, data: value }));
    };
    await waitFor(() => client.readyState === WebSocket.OPEN || undefined, "OneBot 点赞测试连接未就绪。");
    let sequence = 2;
    function send(message: unknown, group_id = group) {
      client.send(JSON.stringify({ self_id: 99, user_id: sender, group_id, post_type: "message",
        message_type: "group", sub_type: "normal", message_id: ++sequence, raw_message: String(sequence), message }));
    }
    const mention = (qq: number | string) => ({ type: "at", data: { qq } });
    const command = { type: "text", data: { text: "#赞他" } };
    send([command, mention(99), mention(String(target))]);
    const onebotReply = await waitFor(() => oneBotCalls.find(call => call.action === "send_msg" &&
      textOf(call).includes("42 收到 3 次")), "OneBot 未确认指定对象与次数。");
    expect(oneBotCalls.filter(call => call.action === "send_like")).toEqual([
      { action: "send_like", params: { user_id: target, times: 3 } },
    ]);
    expect((onebotReply.params.message as unknown[]).slice(0, 2)).toMatchObject([
      { type: "reply" }, { type: "at", data: { qq: "42" } },
    ]);
    expect(oneBotCalls.filter(call => call.action === "get_group_member_info")).toHaveLength(2);

    send([command, mention(44)]);
    await waitFor(() => oneBotCalls.find(call => call.action === "send_msg" &&
      JSON.stringify(call.params.message).includes("当前账号无法评价该资料卡")), "未拒绝其他群的成员回执。");
    send([command, mention(target), mention(43)]);
    await waitFor(() => oneBotCalls.find(call => call.action === "send_msg" &&
      JSON.stringify(call.params.message).includes("只 @ 一位其他群成员")), "未拒绝多个 @。");
    send([command, mention(target)], 78);

    const webhook = (event_type: string, data: object) => fetch(new URL("/milky", http), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ self_id: 100, time: 1_700_000_000, event_type, data }),
      signal: AbortSignal.timeout(2_000),
    });
    await waitFor(async () => (await webhook("fixture", {})).status === 200 || undefined, "Milky 点赞测试连接未就绪。");
    expect((await webhook("message_receive", { time: 1_700_000_000, sender_id: sender, peer_id: group,
      message_seq: 11, message_scene: "group", segments: [
        { type: "text", data: { text: "赞Ta" } }, { type: "mention", data: { user_id: target } },
      ] })).status).toBe(200);
    const milkyReply = await waitFor(() => milkyCalls.find(call => call.action === "send_group_message" &&
      textOf(call).includes("42 收到 3 次")), "Milky 未确认指定对象与次数。");
    expect((milkyReply.params.message as unknown[]).slice(0, 2)).toMatchObject([
      { type: "reply" }, { type: "mention", data: { user_id: target } },
    ]);
    expect(milkyCalls.filter(call => call.action === "send_profile_like")).toEqual([
      { action: "send_profile_like", params: { user_id: target, count: 3 } },
    ]);
    expect(oneBotCalls.filter(call => call.action === "send_like")).toHaveLength(1);
    expect(oneBotCalls.some(call => call.params.group_id === 78)).toBe(false);
  } finally {
    socket?.close();
    host?.kill("SIGKILL");
    await host?.exited;
    milky.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
