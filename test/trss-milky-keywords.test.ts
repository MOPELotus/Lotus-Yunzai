import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const token = "milky-keywords-fixture";
const bot = 99;
const owner = 51;
const moderator = 42;
const otherBotOwner = 52;
const originalGroup = 77;
const secondGroup = 78;
const time = 1_700_000_000;

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw new Error(description);
}

interface Reply {
  readonly group?: number;
  readonly user?: number;
  readonly text: string;
}

function reply(params: Record<string, unknown>): Reply {
  const message = params.message;
  return {
    group: Number(params.group_id) || undefined,
    user: Number(params.user_id) || undefined,
    text: typeof message === "string" ? message : Array.isArray(message)
      ? message.filter(part => part.type === "text").map(part => part.data.text).join("") : "",
  };
}

function gateway() {
  const sockets: Bun.ServerWebSocket<unknown>[] = [];
  const replies: Reply[] = [];
  const roleQueries: Record<string, unknown>[] = [];
  let mismatched = false;
  let role = "admin";
  const success = (data: object) => Response.json({ status: "ok", retcode: 0, data });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      if (path === "/event" && server.upgrade(request)) return;
      if (request.method !== "POST") return new Response(null, { status: 404 });
      const params = await request.json() as Record<string, unknown>;
      switch (path) {
        case "/api/get_login_info": return success({ uin: bot, nickname: "词条夹具" });
        case "/api/get_group_member_info": {
          roleQueries.push(params);
          return success({ member: { user_id: params.user_id, group_id: mismatched ? 79 : params.group_id, role } });
        }
        case "/api/send_group_message":
        case "/api/send_private_message":
          replies.push(reply(params));
          return success({ message_seq: replies.length, time });
        default: return new Response(null, { status: 404 });
      }
    },
    websocket: { open(socket) { sockets.push(socket); }, message() {} },
  });
  let messageSeq = 0;
  return {
    server, sockets, roleQueries,
    setRole(value: string, wrongGroup = false) { role = value; mismatched = wrongGroup; },
    send(text: string, { account = bot, user = moderator, group = originalGroup, connection = sockets.at(-1) }: {
      account?: number; user?: number; group?: number | null; connection?: Bun.ServerWebSocket<unknown>;
    } = {}) {
      connection!.send(JSON.stringify({ self_id: account, time, event_type: "message_receive", data: {
        message_scene: group === null ? "friend" : "group", peer_id: group ?? user, sender_id: user,
        group_member: { group_id: group, user_id: user, role: "admin" },
        isMaster: true, boundAccount: true,
        message_seq: ++messageSeq, time, segments: [{ type: "text", data: { text } }],
      } }));
    },
    next: () => waitFor(() => replies.shift(), "未收到 Milky 词条回复。"),
    expectDrained() { expect(replies).toEqual([]); },
  };
}

async function oneBot(endpoint: string) {
  const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new Socket(endpoint, { headers: {
    Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": String(bot),
  } });
  const connected = Promise.withResolvers<void>();
  const replies: Reply[] = [];
  socket.addEventListener("open", () => connected.resolve(), { once: true });
  socket.addEventListener("error", connected.reject, { once: true });
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.action === "send_msg") replies.push(reply(frame.params));
    if (frame.echo) socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: { message_id: 99 } }));
  });
  await connected.promise;
  let messageId = 0;
  return {
    socket,
    send(text: string, group: number | null = originalGroup) {
      socket.send(JSON.stringify({ self_id: bot, user_id: moderator, group_id: group ?? undefined,
        post_type: "message", message_type: group === null ? "private" : "group", sub_type: group === null ? "friend" : "normal",
        sender: { role: "admin" }, message: text, message_id: ++messageId }));
    },
    next: () => waitFor(() => replies.shift(), "未收到 OneBot 词条回复。"),
  };
}

test("Milky 词条沿用旧文件，按绑定账号鉴权并隔离不同协议与重连草稿", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-keywords-"));
  const milky = gateway();
  try {
    await copyHost(root);
    disableMemberPrewarm(root);
    const config = join(root, "config", "config");
    const data = join(root, "data", "messageJson");
    await mkdir(data, { recursive: true });
    await writeFile(join(config, "other.yaml"), 'master: ["99:51", "100:52"]\n');
    await writeFile(join(config, "group.yaml"), "default: {groupCD: 0, singleCD: 0, addLimit: 1, addPrivate: 1}\n");
    await writeFile(join(root, "config", "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${milky.server.port}`, `access_token: ${token}`,
      "ws:", "  reconnect_interval: 0.05", "  heartbeat: 0.2",
    ].join("\n") + "\n");
    const text = (value: string) => [{ type: "text", text: value }];
    const oldGroup = { 旧群词: [text("旧群内容")] };
    const oldGlobal = { 旧全局词: [text("旧全局内容")] };
    const groupFile = join(data, `${originalGroup}.json`);
    const globalFile = join(data, "global.json");
    await writeFile(groupFile, JSON.stringify(oldGroup));
    await writeFile(globalFile, JSON.stringify(oldGlobal));
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token, LOTUS_PROFILE_DIR: join(root, "profiles") },
    });
    let startup = "";
    const stdout = (async () => { for await (const chunk of host.stdout) startup += new TextDecoder().decode(chunk); })();
    const stderr = new Response(host.stderr).text();
    let one: Awaited<ReturnType<typeof oneBot>> | undefined;
    try {
      const endpoint = await waitFor(() => startup.includes("Lotus-Yunzai 已启动")
        ? /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(startup)?.[0] : undefined, "测试宿主未启动。");
      one = await oneBot(endpoint);
      const originalSocket = await waitFor(() => milky.sockets[0], "Milky 测试网关未连接。");

      milky.send("#全局添加 另一个账号的主人", { account: 100, user: otherBotOwner });
      milky.send("#全局添加 普通成员", { user: otherBotOwner });
      expect((await milky.next()).text).toContain("只有主人");

      milky.send("旧群词");
      expect(await milky.next()).toMatchObject({ group: originalGroup, text: "旧群内容" });
      expect(await readFile(groupFile, "utf8")).toBe(JSON.stringify(oldGroup));
      expect(await readFile(globalFile, "utf8")).toBe(JSON.stringify(oldGlobal));

      one.send("#添加 OneBot词");
      expect((await one.next()).text).toContain("#结束添加");
      milky.send("#添加 Milky词");
      expect((await milky.next()).text).toContain("#结束添加");
      one.send("OneBot 内容");
      milky.send("Milky 内容");
      one.send(" #结束添加");
      milky.send("#结束添加 ");
      expect((await one.next()).text).toBe("添加成功：OneBot词");
      expect((await milky.next()).text).toBe("添加成功：Milky词");
      expect(JSON.parse(await readFile(groupFile, "utf8"))).toEqual({
        ...oldGroup, OneBot词: [text("OneBot 内容")], Milky词: [text("Milky 内容")],
      });

      milky.send("旧全局词", { group: secondGroup });
      expect(await milky.next()).toMatchObject({ group: secondGroup, text: "旧全局内容" });
      one.send("旧群词", null);
      expect(await one.next()).toMatchObject({ user: moderator, text: "旧群内容" });
      milky.setRole("admin", true);
      milky.send("#添加 私聊词", { group: null });
      expect((await milky.next()).text).toContain("无法确认管理员权限");
      expect(milky.roleQueries.at(-1)).toEqual({ group_id: secondGroup, user_id: moderator, no_cache: true });
      milky.setRole("admin");
      milky.send("#添加 私聊词", { group: null });
      expect((await milky.next()).text).toContain("#结束添加");
      milky.send("私聊内容", { group: null });
      milky.send("#结束添加", { group: null });
      expect((await milky.next()).text).toBe("添加成功：私聊词");
      expect(JSON.parse(await readFile(join(data, `${secondGroup}.json`), "utf8"))).toEqual({ 私聊词: [text("私聊内容")] });

      milky.send("#全局添加 主人测试", { user: owner });
      expect((await milky.next()).text).toContain("#结束添加");
      milky.send("授权全局内容", { user: owner });
      milky.send("#结束添加", { user: owner });
      expect((await milky.next()).text).toBe("添加成功：主人测试");
      milky.send("#全局删除 主人测试", { user: owner });
      expect((await milky.next()).text).toBe("删除成功：主人测试");
      expect(JSON.parse(await readFile(globalFile, "utf8"))).toEqual(oldGlobal);

      milky.send("#添加 失效词");
      expect((await milky.next()).text).toContain("#结束添加");
      milky.send("旧连接的草稿", { connection: originalSocket });
      originalSocket.close(1012, "fixture reconnect");
      await waitFor(() => milky.sockets[1], "Milky 测试网关未重连。");
      milky.send("  #结束添加");
      expect((await milky.next()).text).toContain("添加已失效");
      expect(JSON.parse(await readFile(groupFile, "utf8"))).not.toHaveProperty("失效词");
      milky.send("#删除 Milky词");
      expect((await milky.next()).text).toBe("删除成功：Milky词");
      expect(JSON.parse(await readFile(groupFile, "utf8"))).toEqual({ ...oldGroup, OneBot词: [text("OneBot 内容")] });
      milky.expectDrained();

      one.send("#添加 OneBot旧连接词");
      expect((await one.next()).text).toContain("#结束添加");
      one.send("OneBot 旧连接的草稿");
      const oneClosed = Promise.withResolvers<void>();
      one.socket.addEventListener("close", () => oneClosed.resolve(), { once: true });
      one.socket.close();
      await oneClosed.promise;
      one = await oneBot(endpoint);
      one.send("   #结束添加");
      expect((await one.next()).text).toContain("添加已失效");
      expect(JSON.parse(await readFile(groupFile, "utf8"))).not.toHaveProperty("OneBot旧连接词");
    } finally {
      one?.socket.close();
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
      const forceStop = setTimeout(() => host.kill("SIGKILL"), 1_500);
      await host.exited;
      clearTimeout(forceStop);
      await stdout;
      expect(await stderr).not.toContain(token);
    }
  } finally {
    milky.server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
