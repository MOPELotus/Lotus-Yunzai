import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindMessageGroupMute } from "../lib/adapters/group-moderation.ts";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const group = 77;
const oneBotId = 99;
const milkyId = 100;
const operator = 51;
const token = "group-admin-mute-fixture";
type Call = { readonly action: string; readonly params: Record<string, unknown> };

async function waitUntil<T>(read: () => T | undefined, description: string): Promise<T> {
  const until = performance.now() + 3_500;
  while (performance.now() < until) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error(description);
}

function liveMember({ group_id, user_id }: Call["params"]) {
  const role = user_id === milkyId ? "owner" : [oneBotId, operator, 53].includes(Number(user_id)) ? "admin" : "member";
  return { group_id: user_id === 45 ? 80 : group_id, user_id, role };
}

test("预检期间关机时当前会话不能继续禁言", async () => {
  const requested = Promise.withResolvers<void>();
  let active = true;
  let sent = 0;
  const mute = bindMessageGroupMute({
    bot: 99, actor: 51, signal: new AbortController().signal, accepting: () => active, isMaster: () => true,
    isProtected: () => false, async role(id) {
      if (id === 42) await requested.promise;
      return id === 99 ? "admin" : "member";
    },
    async mute() { sent++; return "confirmed"; },
  });
  const held = mute(42, 300);
  active = false;
  requested.resolve();
  expect(await held).toBe("unavailable");
  expect(sent).toBe(0);
});

test("旧禁言指令在 OneBot 与 Milky 只操作当前已复核的群成员", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-group-mute-wire-"));
  const milkyCalls: Call[] = [];
  const milky = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const action = new URL(request.url).pathname.split("/").at(-1)!;
      const params = await request.json() as Call["params"];
      milkyCalls.push({ action, params });
      if (action === "set_group_member_mute" && params.user_id === 44) return new Response(null, { status: 503 });
      const data = action === "get_login_info" ? { uin: milkyId } : action === "get_group_member_info" ?
        { member: liveMember(params) } : action === "send_group_message" ? { message_seq: milkyCalls.length } : {};
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
    await writeFile(join(root, "config/other.yaml"), 'master: ["100:51"]\nmasterQQ: [52]\n');
    await writeFile(join(root, "config/group.yaml"), "default: {groupCD: 0, singleCD: 0}\n78: {disable: [椰奶群管-基础]}\n");
    await writeFile(join(root, "config/milky.yaml"),
      `enable: true\nhost: 127.0.0.1\nport: ${milky.port}\nconnection: webhook\naccess_token: ${token}\n`);
    disableMemberPrewarm(root);
    host = Bun.spawn([process.execPath, "app.ts"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_TOKEN: token } });
    const output = { stdout: "", stderr: "" };
    const read = (stream: ReadableStream<Uint8Array>, key: keyof typeof output) => {
      const decoder = new TextDecoder();
      return stream.pipeTo(new WritableStream({ write(chunk) { output[key] += decoder.decode(chunk, { stream: true }); } }));
    };
    void read(host.stdout, "stdout");
    void read(host.stderr, "stderr");
    const ws = await waitUntil(() => /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output.stdout)?.[0], output.stderr);
    const http = await waitUntil(() => /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output.stdout)?.[1], output.stderr);
    const Gateway = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const client = socket = new Gateway(ws, { headers: {
      Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": String(oneBotId),
    } });
    const oneBotCalls: Call[] = [];
    client.onmessage = ({ data }) => {
      const { action, params, echo } = JSON.parse(data);
      oneBotCalls.push({ action, params });
      if (echo) client.send(JSON.stringify({ echo, status: "ok", retcode: 0, data: action === "get_group_member_info" ?
        liveMember(params) : action === "send_msg" ? { message_id: oneBotCalls.length } : {} }));
    };
    await waitUntil(() => client.readyState === WebSocket.OPEN || undefined, "OneBot 测试连接未就绪。");

    const text = (value: string) => ({ type: "text", data: { text: value } });
    let sequence = 10;
    const oneBotMessage = (message: unknown, user_id = operator, group_id = group) => ({
      post_type: "message", message_type: "group", sub_type: "normal", self_id: oneBotId, user_id,
      group_id, sender: { role: "admin" }, message_id: ++sequence, raw_message: String(sequence), message,
    });
    const send = (message: ReturnType<typeof oneBotMessage>) => client.send(JSON.stringify(message));
    const oneBotMuted = () => oneBotCalls.filter(({ action }) => action === "set_group_ban").map(({ params }) => params);
    const oneBotReplies = () => oneBotCalls.filter(({ action }) => action === "send_msg");
    const oneBotReply = (count: number) => waitUntil(() => oneBotReplies().at(count - 1), "OneBot 群管理指令未回复。");
    const at = (qq: number) => ({ type: "at", data: { qq: String(qq) } });
    send(oneBotMessage([text("#禁言"), at(oneBotId), at(42), text(" 2分钟")]));
    expect(JSON.stringify((await oneBotReply(1)).params.message)).toContain("已将 42 禁言 120 秒");
    send(oneBotMessage("#解禁42"));
    expect(JSON.stringify((await oneBotReply(2)).params.message)).toContain("解除禁言");
    send(oneBotMessage("#禁言42 60秒", 54));
    await oneBotReply(3);
    send(oneBotMessage("#禁言45", operator));
    await oneBotReply(4);
    send(oneBotMessage("#禁言52", operator));
    await oneBotReply(5);
    send(oneBotMessage("#禁言42", operator, 78));
    expect(oneBotMuted()).toEqual([
      { group_id: group, user_id: 42, duration: 120 }, { group_id: group, user_id: 42, duration: 0 },
    ]);
    expect(oneBotCalls.filter(({ action }) => action === "get_group_member_info").every(({ params }) => params.no_cache === true)).toBe(true);

    const webhook = (event_type: string, data: object) => fetch(new URL("/milky", http), { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ event_type, self_id: milkyId, time: Math.floor(Date.now() / 1000), data }),
      signal: AbortSignal.timeout(2_000),
    });
    await waitUntil(() => milkyCalls.find(({ action }) => action === "get_login_info"), "Milky 未识别机器人。");
    const readyDeadline = performance.now() + 2_000;
    while (true) {
      const response = await webhook("fixture_unsupported", {});
      if (response.status !== 503 || performance.now() >= readyDeadline) { expect(response.status).toBe(200); break; }
      await Bun.sleep(20);
    }
    const milkyMessage = (message: string) => ({ message_scene: "group", peer_id: group, sender_id: operator,
      message_seq: ++sequence, group_member: { group_id: group, user_id: operator, role: "admin" }, segments: [text(message)],
    });
    const milkyReply = (count: number) => waitUntil(
      () => milkyCalls.filter(({ action }) => action === "send_group_message").at(count - 1), "Milky 群管理指令未回复。",
    );
    expect((await webhook("message_receive", milkyMessage("#禁言53 30秒"))).status).toBe(200);
    expect(JSON.stringify((await milkyReply(1)).params.message)).toContain("已将 53 禁言 30 秒");
    const uncertain = milkyMessage("#禁言44 3秒");
    expect((await webhook("message_receive", uncertain)).status).toBe(200);
    expect(JSON.stringify((await milkyReply(2)).params.message)).toContain("操作结果未确认");
    expect((await webhook("message_receive", uncertain)).status).toBe(200);
    await webhook("message_receive", milkyMessage("#解禁53"));
    await milkyReply(3);
    expect(milkyCalls.filter(({ action }) => action === "set_group_member_mute").map(({ params }) => params)).toEqual([
      { group_id: group, user_id: 53, duration: 30 },
      { group_id: group, user_id: 44, duration: 3 },
      { group_id: group, user_id: 53, duration: 0 },
    ]);
    expect(oneBotMuted()).toHaveLength(2);
  } finally {
    socket?.close();
    host?.kill();
    await host?.exited;
    milky.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 14_000);
