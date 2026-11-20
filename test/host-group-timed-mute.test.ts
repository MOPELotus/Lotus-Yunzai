import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const valkeyServer = Bun.which("valkey-server");
const token = "scheduled-group-mute-fixture";
const bot = 99;
const issuer = 51;
const legacyKey = "yenai:MuteTasks";
type Action = { action: string; params: Record<string, unknown>; echo?: string };

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, description: string): Promise<T> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(15);
  }
  throw new Error(description);
}

test.skipIf(!valkeyServer)("旧全员禁言任务须同号同群重新绑定，触发时复核双协议实际权限", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-timed-group-mute-"));
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const password = crypto.randomUUID();
  const valkey = Bun.spawn([valkeyServer!, "--bind", "127.0.0.1", "--port", String(port),
    "--requirepass", password, "--save", "", "--appendonly", "no", "--dir", root], { stdout: "ignore", stderr: "ignore" });
  const redisUrl = `redis://:${password}@127.0.0.1:${port}`;
  let redis: InstanceType<typeof Bun.RedisClient> | undefined;
  const oneBot: Action[] = [];
  const milky: Action[] = [];
  let oneBotAuthority = true;
  const member = (params: Action["params"], authorized: boolean) => {
    const { group_id, user_id } = params;
    return { group_id, user_id, role: user_id === bot || (user_id === issuer && authorized) ? "admin" : "member" };
  };
  const milkyGateway = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const action = new URL(request.url).pathname.split("/").at(-1)!;
      const params = await request.json() as Action["params"];
      milky.push({ action, params });
      const data = action === "get_login_info" ? { uin: bot } :
        action === "get_group_member_info" ? { member: member(params, true) } :
          action === "send_group_message" ? { message_seq: milky.length } : {};
      return Response.json({ status: "ok", retcode: 0, data });
    },
  });
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let socket: WebSocket | undefined;
  try {
    redis = await waitFor(async () => {
      const client = new Bun.RedisClient(redisUrl, { autoReconnect: false });
      try {
        await client.connect();
        return client;
      } catch {
        client.close();
        return undefined;
      }
    }, "隔离 Valkey 未就绪。");
    const legacy = '[{"cron":"*/1 * * * * ?","group":77,"type":true,"botId":99}, {"cron":"*/1 * * * * ?","group":"78","type":false,"botId":"99"}]';
    await redis.set(legacyKey, legacy);
    await copyHost(root);
    await cp(new URL("../plugins/group", import.meta.url), join(root, "plugins/group"), {
      recursive: true, filter: path => !path.endsWith("/.git") && !path.endsWith("/node_modules"),
    });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/group.yaml"), "default: {groupCD: 0, singleCD: 0}\n");
    await writeFile(join(root, "config/milky.yaml"),
      `enable: true\nhost: 127.0.0.1\nport: ${milkyGateway.port}\nconnection: webhook\naccess_token: ${token}\n`);
    disableMemberPrewarm(root);
    host = Bun.spawn([process.execPath, "app.ts"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_TOKEN: token, LOTUS_VALKEY_URL: redisUrl } });
    let output = "";
    const decoder = new TextDecoder();
    void host.stdout.pipeTo(new WritableStream({ write(chunk) { output += decoder.decode(chunk, { stream: true }); } }));
    const ws = await waitFor(() => /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0], "OneBot 测试入口未就绪。");
    const http = await waitFor(() => /HTTP 正在监听 (http:\/\/127\.0\.0\.1:\d+)\/status/u.exec(output)?.[1], "HTTP 测试入口未就绪。");
    const Gateway = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const client = socket = new Gateway(ws, {
      headers: { Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": String(bot) },
    });
    client.onmessage = ({ data }) => {
      const frame = JSON.parse(data) as Action;
      oneBot.push(frame);
      if (!frame.echo) return;
      const response = frame.action === "get_group_member_info" ? member(frame.params, oneBotAuthority) : { message_id: oneBot.length };
      client.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: response }));
    };
    await waitFor(() => client.readyState === WebSocket.OPEN || undefined, "OneBot 测试网关未绑定。");
    const hook = (event_type: string, data: object) => fetch(new URL("/milky", http), { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ event_type, self_id: bot, time: Math.floor(Date.now() / 1000), data }),
      signal: AbortSignal.timeout(2_000),
    });
    await waitFor(async () => (await hook("fixture", {})).status === 200 || undefined, "Milky 测试网关未绑定。");
    let messageId = 100;
    const send = (message: string, group_id = 77) => client.send(JSON.stringify({ post_type: "message", message_type: "group",
      sub_type: "normal", self_id: bot, user_id: issuer, group_id, message_id: ++messageId, message }));
    const sendMilky = (message: string, peer_id = 78) => hook("message_receive", { message_scene: "group", peer_id,
      sender_id: issuer, message_seq: ++messageId, segments: [{ type: "text", data: { text: message } }] });
    const oneBotWrites = () => oneBot.filter(({ action }) => action === "set_group_whole_ban");
    const milkyWrites = () => milky.filter(({ action }) => action === "set_group_whole_mute");
    send("#定时禁言任务");
    await waitFor(() => oneBot.find(({ action, params }) =>
      (action === "send_msg" || action === "send_group_forward_msg") && JSON.stringify(params).includes("待绑定")), "旧任务没有显示待绑定。");
    await Bun.sleep(1_100);
    expect(oneBotWrites()).toHaveLength(0);
    expect(milkyWrites()).toHaveLength(0);

    send("#绑定旧定时禁言");
    expect((await sendMilky("#绑定旧定时解禁")).status).toBe(200);
    await waitFor(() => oneBotWrites()[0], "OneBot 已绑定的定时禁言未触发。");
    await waitFor(() => milkyWrites()[0], "Milky 已绑定的定时解禁未触发。");
    expect(oneBotWrites().every(({ params }) => params.group_id === 77 && params.enable === true)).toBe(true);
    expect(milkyWrites().every(({ params }) => params.group_id === 78 && params.is_mute === false)).toBe(true);

    oneBotAuthority = false;
    const prior = oneBotWrites().length;
    await Bun.sleep(1_150);
    expect(oneBotWrites()).toHaveLength(prior);
    oneBotAuthority = true;
    send("#取消定时禁言");
    await waitFor(() => oneBot.find(({ action, params }) => action === "send_msg" && JSON.stringify(params).includes("取消")),
      "取消命令未回复。");
    const stopped = oneBotWrites().length;
    await Bun.sleep(1_150);
    expect(oneBotWrites()).toHaveLength(stopped);
    expect(await redis.get(legacyKey)).toBe(legacy);
  } finally {
    socket?.close();
    host?.kill();
    await host?.exited;
    redis?.close();
    valkey.kill("SIGKILL");
    await valkey.exited;
    milkyGateway.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 16_000);
