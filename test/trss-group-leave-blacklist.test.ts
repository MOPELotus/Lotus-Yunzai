import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const valkeyServer = Bun.which("valkey-server");
const valkeyCli = Bun.which("valkey-cli");
const token = "group-leave-blacklist-fixture";
const time = 1_700_000_000;
const group = 70101;
const owner = 51;
type Action = { action: string; params: Record<string, unknown> };

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, description: string): Promise<T> {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error(description);
}

test.skipIf(!valkeyServer || !valkeyCli)("旧退群黑名单在双协议上保留群记录与全局配置，已封用户仍受入群拦截", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-group-leave-blacklist-"));
  const listen = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listen.port;
  listen.stop(true);
  const password = crypto.randomUUID();
  const server = Bun.spawn([valkeyServer!, "--bind", "127.0.0.1", "--port", String(port), "--requirepass", password,
    "--save", "", "--appendonly", "no", "--dir", root], { stdout: "ignore", stderr: "ignore" });
  const redis = async (...args: string[]): Promise<unknown> => {
    const call = Bun.spawn([valkeyCli!, "-p", String(port), "--json", ...args], {
      stdout: "pipe", stderr: "ignore", env: { ...process.env, REDISCLI_AUTH: password },
    });
    const [out, status] = await Promise.all([new Response(call.stdout).text(), call.exited]);
    if (status !== 0) throw new Error("测试 Valkey 指令未完成。");
    return JSON.parse(out);
  };
  const milkyActions: Action[] = [];
  const gateway = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const action = new URL(request.url).pathname.split("/").at(-1)!;
      const params = await request.json() as Record<string, unknown>;
      milkyActions.push({ action, params });
      const data = action === "get_login_info" ? { uin: 100 } : action === "send_group_message" ? { message_seq: 7 } : {};
      const unknown = action === "reject_group_request" && params.notification_seq === 802;
      return unknown ? new Response(null, { status: 503 }) : Response.json({ status: "ok", retcode: 0, data });
    },
  });
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let socket: WebSocket | undefined;
  try {
    await waitFor(async () => await redis("PING").catch(() => undefined) === "PONG" || undefined, "隔离 Valkey 未就绪。");
    await copyHost(root);
    await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins/group"), {
      recursive: true, filter: path => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
    });
    await mkdir(join(root, "config/config"), { recursive: true });
    const other = join(root, "config/config/other.yaml");
    const settings = join(root, "config/config/group-leave-blacklist.yaml");
    await writeFile(other, 'master: ["99:51", "100:51"]\nmasterQQ: [52]\nblackUser: [60] # 手动名单\n');
    await writeFile(settings, `enable: true\ngroups: [${group}]\n`);
    await writeFile(join(root, "config/group.yaml"), "default: {groupCD: 0, singleCD: 0}\n");
    await writeFile(join(root, "config/milky.yaml"),
      `enable: true\nhost: 127.0.0.1\nport: ${gateway.port}\nconnection: webhook\naccess_token: ${token}\n`);
    disableMemberPrewarm(root);
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token, LOTUS_HTTP_PORT: "0",
        LOTUS_VALKEY_URL: `redis://:${password}@127.0.0.1:${port}` },
    });
    let output = "";
    const decoder = new TextDecoder();
    void host.stdout.pipeTo(new WritableStream({ write(bytes) { output += decoder.decode(bytes, { stream: true }); } }));
    const endpoint = await waitFor(() => /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0], "OneBot 测试入口未就绪。");
    const http = await waitFor(() => /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1], "HTTP 测试入口未就绪。");
    const WebSocketWithHeaders = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    socket = new WebSocketWithHeaders(endpoint, { headers: {
      Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99",
    } });
    const connection = socket;
    const onebotActions: Action[] = [];
    connection.onmessage = ({ data }) => {
      const { action, params, echo } = JSON.parse(data);
      onebotActions.push({ action, params });
      const reply = action === "send_msg" ? { message_id: 1 } : {};
      if (echo) connection.send(JSON.stringify({ echo, status: "ok", retcode: 0, data: reply }));
    };
    await waitFor(() => connection.readyState === WebSocket.OPEN || undefined, "OneBot 测试网关未连接。");
    const onebot = (action: object) => connection.send(JSON.stringify({ self_id: 99, group_id: group, time, ...action }));
    const notice = (direction: string, user_id: number, extra = {}) =>
      onebot({ post_type: "notice", notice_type: `group_${direction}`, user_id, ...extra });
    const application = (user_id: number, flag: string, sub_type = "add") =>
      onebot({ post_type: "request", request_type: "group", sub_type, user_id, flag });
    const milky = async (event_type: string, data: object, authenticated = true) => fetch(new URL("/milky", http), {
      method: "POST", headers: { "Content-Type": "application/json", ...(authenticated && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ self_id: 100, time, event_type, data }), signal: AbortSignal.timeout(2_000),
    });
    await waitFor(async () => (await milky("fixture", {})).status === 200 || undefined, "Milky 测试网关未连接。");
    const key = `Yz:group-leave-blacklist:${group}`;
    const recording = (user: number) => redis("HGET", key, String(user));
    const readGlobal = async () => (Bun.YAML.parse(await readFile(other, "utf8")) as { blackUser: number[] }).blackUser;
    async function waitForRecord(user: number, bot: number) {
      const value = await waitFor(async () => await recording(user) ?? undefined, "旧群哈希记录未写入。");
      expect(JSON.parse(value as string)).toMatchObject({ self_id: bot, time });
      await waitFor(async () => (await readGlobal()).includes(user) || undefined, "全局黑名单未写入。");
    }

    await redis("HSET", key, "60", JSON.stringify({ self_id: 99, time, name: "旧记录" }));
    application(60, "existing");
    expect((await waitFor(() => onebotActions.find(a => a.action === "set_group_add_request"), "旧成员申请未拦截。")).params)
      .toEqual({ flag: "existing", approve: false, sub_type: "add", reason: "主动退群被拉黑" });

    notice("decrease", 42, { sub_type: "leave", member: { card: "旧群名片" } });
    await waitForRecord(42, 99);
    expect(JSON.parse(await recording(42) as string).name).toBe("旧群名片");
    notice("increase", 42);
    expect((await waitFor(() => onebotActions.find(a => a.action === "set_group_kick"), "OneBot 重加入群未拦截。")).params)
      .toEqual({ group_id: group, user_id: 42, reject_add_request: false });
    application(42, "invite", "invite");
    notice("decrease", owner);
    notice("decrease", 52);
    notice("decrease", 44, { dismiss: true });
    notice("decrease", 45, { group_id: group + 1 });
    notice("decrease", 46, { self_id: 101 });

    expect((await milky("group_member_decrease", { group_id: group, user_id: 47 }, false)).status).toBe(401);
    expect((await milky("group_member_decrease", { group_id: group, user_id: 43, operator_id: 55 })).status).toBe(200);
    await waitForRecord(43, 100);
    expect((await milky("group_member_increase", { group_id: group, user_id: 43 })).status).toBe(200);
    expect((await waitFor(() => milkyActions.find(a => a.action === "kick_group_member"), "Milky 重加入群未拦截。")).params)
      .toEqual({ group_id: group, user_id: 43 });
    const request = { group_id: group, initiator_id: 43, notification_seq: 802, is_filtered: true };
    expect((await milky("group_join_request", request)).status).toBe(200);
    expect((await milky("message_receive", { time, message_seq: 10, message_scene: "group", peer_id: group,
      sender_id: owner, segments: [{ type: "text", data: { text: "#退群拉黑查询 43" } }] })).status).toBe(200);
    const milkyReply = await waitFor(() => milkyActions.find(a => a.action === "send_group_message" &&
      JSON.stringify(a.params).includes("43 在本群退群黑名单中")), "Milky 主人查询命令未回复。");
    expect(milkyReply.params.group_id).toBe(group);
    expect((await waitFor(() => milkyActions.find(a => a.action === "reject_group_request"), "Milky 加群申请未拦截。")).params)
      .toEqual({ group_id: group, notification_seq: 802, is_filtered: true, notification_type: "join_request", reason: "主动退群被拉黑" });
    expect((await milky("group_join_request", request)).status).toBe(200);

    const command = "#退群拉黑解除 42";
    const message = (user_id: number, message_id: number) =>
      onebot({ post_type: "message", message_type: "group", sub_type: "normal", user_id, message_id, message: command });
    message(48, 1);
    await Bun.sleep(60);
    expect(await recording(42)).not.toBeNull();
    message(owner, 2);
    const reply = await waitFor(() => onebotActions.find(a => a.action === "send_msg" && JSON.stringify(a.params).includes("已解除 42")),
      "主人解除命令未回复。");
    expect(JSON.stringify(reply.params)).toContain("全局黑名单如有记录，仍需手动处理");
    await writeFile(settings, `enable: false\ngroups: [${group}]\n`);
    notice("decrease", 49);
    await Bun.sleep(120);
    expect(await recording(42)).toBeNull();
    expect(await readGlobal()).toEqual([60, 42, 43]);
    expect((await redis("HKEYS", key) as string[]).sort()).toEqual(["43", "60"]);
    expect(onebotActions.filter(a => a.action === "set_group_add_request")).toHaveLength(1);
    expect(milkyActions.filter(a => a.action === "reject_group_request")).toHaveLength(1);
  } finally {
    socket?.close();
    gateway.stop(true);
    host?.kill("SIGKILL");
    server.kill("SIGKILL");
    await Promise.all([host?.exited, server.exited]);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
