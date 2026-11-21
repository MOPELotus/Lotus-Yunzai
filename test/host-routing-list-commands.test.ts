import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "host-routing-list-fixture";
const time = 1_700_000_000;
type Call = { action: string; params: Record<string, unknown>; echo?: string };

async function endpoints(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const ws = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      const http = /http:\/\/127\.0\.0\.1:\d+\/status/u.exec(output)?.[0];
      if (http && ws) return { ws, webhook: new URL("/milky", http) };
      const chunk = await reader.read();
      if (chunk.done) throw new Error(output);
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function next(calls: Call[]): Promise<Call> {
  const limit = performance.now() + 2_000;
  while (!calls.length && performance.now() < limit) await Bun.sleep(10);
  if (!calls.length) throw new Error("模拟网关未收到预期回执。");
  return calls.shift()!;
}

test("隔离宿主两协议变更全局名单，立即影响派发并保留主人私聊恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-host-access-list-"));
  const oneBotCalls: Call[] = [];
  const milkyCalls: Call[] = [];
  const gateway = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const action = new URL(request.url).pathname.split("/").at(-1)!;
      if (action === "get_login_info") return Response.json({ status: "ok", retcode: 0, data: { uin: 100 } });
      const params = await request.json() as Call["params"];
      milkyCalls.push({ action, params });
      return Response.json({ status: "ok", retcode: 0, data: { message_seq: 200 } });
    },
  });
  try {
    await copyHost(root);
    const policy = join(root, "config", "other.yaml");
    const legacy = join(root, "config/config", "other.yaml");
    await mkdir(join(root, "config/config"), { recursive: true });
    const source = 'master: ["99:42", "100:43"]  # 主人\nblackUser: [88]\nextra:    {flag: true}\n';
    const legacySource = "masterQQ: [99]\nblackUser: [123]\n";
    await writeFile(policy, source);
    await writeFile(legacy, legacySource);
    await writeFile(join(root, "config", "bot.yaml"), "file_watch: false\n");
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${gateway.port}`, "connection: webhook", `access_token: ${token}`, "",
    ].join("\n"));
    const fixture = join(root, "plugins", "routing-check");
    await mkdir(fixture);
    await writeFile(join(fixture, "package.json"), '{"name":"routing-check","lotusYunzai":{"entry":"./index.ts"}}');
    await writeFile(join(fixture, "index.ts"), 'export default { commands: { "#路由探针": () => "消息已派发" } };');
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_HTTP_PORT: "0", LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    let socket: WebSocket | undefined;
    const stderr = new Response(host.stderr).text();
    try {
      const url = await endpoints(host.stdout);
      const connect = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
      const ws = socket = new connect(url.ws, { headers: {
        Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": "99",
      } });
      const open = Promise.withResolvers<void>();
      ws.addEventListener("open", () => open.resolve(), { once: true });
      ws.addEventListener("error", () => open.reject(new Error("OneBot 模拟网关未连接")), { once: true });
      ws.addEventListener("message", ({ data }) => {
        const call = JSON.parse(data) as Call;
        oneBotCalls.push(call);
        ws.send(JSON.stringify({ echo: call.echo, status: "ok", retcode: 0, data: { message_id: 200 } }));
      });
      await open.promise;
      function webhook(event: object) {
        return fetch(url.webhook, { method: "POST", headers: {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        }, body: JSON.stringify(event), signal: AbortSignal.timeout(2_000) });
      }
      for (let attempt = 0; ; attempt++) {
        const response = await webhook({ event_type: "fixture", self_id: 100, time, data: {} });
        if (response.status === 200) break;
        if (response.status !== 503 || attempt >= 25) throw new Error("Milky 模拟网关未连接");
        await Bun.sleep(20);
      }
      let sequence = 0;
      function sendOneBot(message: unknown, fields: object = {}) {
        ws.send(JSON.stringify({ post_type: "message", message_type: "private", sub_type: "friend", message_id: ++sequence,
          self_id: 99, user_id: 42, time, message, ...fields }));
      }
      function sendMilky(text: string, fields: object = {}, self_id = 100) {
        return webhook({ event_type: "message_receive", self_id, time, data: {
          message_scene: "friend", sender_id: 43, peer_id: 43, time, message_seq: ++sequence,
          segments: [{ type: "text", data: { text } }], ...fields,
        } });
      }
      const oneBotReply = async (message: string, target: object = { user_id: 42 }) =>
        expect(await next(oneBotCalls)).toMatchObject({ action: "send_msg", params: { ...target, message } });
      const milkyReply = async (text: string, user_id = 43) => expect(await next(milkyCalls)).toMatchObject({
        action: "send_private_message", params: { user_id, message: [{ type: "text", data: { text } }] },
      });
      async function silence() {
        await Bun.sleep(100);
        expect(oneBotCalls).toEqual([]);
        expect(milkyCalls).toEqual([]);
      }

      sendOneBot("#拉黑71", { user_id: 43 });
      sendOneBot("#拉白71", { sender: { user_id: 43 } });
      sendOneBot("#拉白72", { sub_type: "group" });
      sendOneBot("#拉黑73", { self_id: 100, user_id: 43 });
      await sendMilky("#拉黑70", { sender_id: 42, peer_id: 42 });
      await sendMilky("#拉黑74", {}, 99);
      await silence();
      expect(await readFile(policy, "utf8")).toBe(source);

      sendOneBot("#拉黑 43");
      await oneBotReply("不能拉黑已配置的机器人主人。");
      sendOneBot("#拉黑55");
      await oneBotReply("已将 55 进行拉黑处理。");
      await sendMilky("#路由探针", { sender_id: 55, peer_id: 55 });
      await silence();
      await sendMilky("#删除拉黑 55");
      await milkyReply("已将 55 进行取消拉黑处理。");
      await sendMilky("#路由探针", { sender_id: 55, peer_id: 55 });
      await milkyReply("消息已派发", 55);

      await sendMilky("#拉白55");
      await milkyReply("已将 55 进行拉白处理。");
      sendOneBot("#路由探针");
      await silence();
      sendOneBot("#取消拉白55");
      await oneBotReply("已将 55 进行取消拉白处理。");
      sendOneBot("#路由探针");
      await oneBotReply("消息已派发");

      const oneBotGroup = { message_type: "group", sub_type: "normal", group_id: 77 };
      sendOneBot("#拉黑群", oneBotGroup);
      await oneBotReply("已将当前群（77）进行拉黑群处理。", { group_id: 77 });
      sendOneBot("#路由探针", oneBotGroup);
      await silence();
      await sendMilky("#移除拉黑群聊 77");
      await milkyReply("已将 77 进行取消拉黑群处理。");
      sendOneBot("#路由探针", oneBotGroup);
      await oneBotReply("消息已派发", { group_id: 77 });
      sendOneBot([{ type: "text", data: { text: "#拉黑" } }, { type: "at", data: { qq: "60" } }], oneBotGroup);
      await oneBotReply("已将 60 进行拉黑处理。", { group_id: 77 });

      sendOneBot("#拉黑 73");
      await sendMilky("#拉黑 74");
      await Promise.all([oneBotReply("已将 73 进行拉黑处理。"), milkyReply("已将 74 进行拉黑处理。")]);
      const updated = await readFile(policy, "utf8");
      expect(updated).toContain('master: ["99:42", "100:43"]  # 主人\n');
      expect(updated).toContain("extra:    {flag: true}\n");
      expect(await readFile(legacy, "utf8")).toBe(legacySource);
      const lists = Bun.YAML.parse(updated) as Record<string, number[]>;
      expect(new Set(lists.blackUser)).toEqual(new Set([88, 60, 73, 74]));
      expect(lists.blackGroup).toEqual([]);
      expect(lists.whiteUser).toEqual([]);
      await writeFile(policy, updated.replace('"99:42", ', ""));
      sendOneBot("#拉黑 75");
      await oneBotReply("拉黑未能完成，请核对 other.yaml 和当前主人配置。");
      expect(await readFile(policy, "utf8")).not.toContain("75");
      await silence();
    } finally {
      socket?.close();
      host.kill();
      await host.exited;
      expect(await stderr).not.toContain("处理 OneBot 事件失败");
    }
  } finally {
    gateway.stop(true);
    await rm(root, { force: true, recursive: true });
  }
}, 12_000);
