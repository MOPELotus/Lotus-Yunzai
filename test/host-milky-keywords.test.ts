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
const mediaSource = "https://multimedia.nt.qq.com.cn/download";
const legacyPhoto = "https://gchat.qpic.cn/gchatpic_new/fixture/0";
const mediaBytes = { photo: [255, 216, 255, 224], voice: [35, 33, 83, 73, 76, 75], video: [0, 0, 0, 16, 102, 116, 121, 112] };
const embedded = (kind: keyof typeof mediaBytes) => `base64://${Buffer.from(mediaBytes[kind]).toString("base64")}`;

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
  readonly parts: readonly { type: string; data: Record<string, unknown> }[];
}

function reply(params: Record<string, unknown>): Reply {
  const message = params.message;
  return {
    group: Number(params.group_id) || undefined,
    user: Number(params.user_id) || undefined,
    text: typeof message === "string" ? message : Array.isArray(message)
      ? message.filter(part => part.type === "text").map(part => part.data.text).join("") : "",
    parts: Array.isArray(message) ? message : [],
  };
}

function gateway() {
  const sockets: Bun.ServerWebSocket<unknown>[] = [];
  const replies: Reply[] = [];
  const roleQueries: Record<string, unknown>[] = [];
  const mediaQueries: unknown[] = [];
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
        case "/api/get_resource_temp_url":
          mediaQueries.push(params.resource_id);
          return success({ url: `${mediaSource}?kind=${params.resource_id}` });
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
    server, sockets, roleQueries, mediaQueries,
    setRole(value: string, wrongGroup = false) { role = value; mismatched = wrongGroup; },
    send(input: string | readonly object[], { account = bot, user = moderator, group = originalGroup, connection = sockets.at(-1) }: {
      account?: number; user?: number; group?: number | null; connection?: Bun.ServerWebSocket<unknown>;
    } = {}) {
      connection!.send(JSON.stringify({ self_id: account, time, event_type: "message_receive", data: {
        message_scene: group === null ? "friend" : "group", peer_id: group ?? user, sender_id: user,
        group_member: { group_id: group, user_id: user, role: "admin" },
        isMaster: true, boundAccount: true,
        message_seq: ++messageSeq, time, segments: typeof input === "string" ? [{ type: "text", data: { text: input } }] : input,
      } }));
    },
    next: () => waitFor(() => replies.shift(), "未收到 Milky 词条回复。"),
    expectDrained() { expect(replies).toEqual([]); },
  };
}

async function oneBot(endpoint: string, account = bot,
  memberInfo?: (params: Record<string, unknown>) => unknown | Promise<unknown>) {
  const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new Socket(endpoint, { headers: {
    Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": String(account),
  } });
  const connected = Promise.withResolvers<void>();
  const replies: Reply[] = [];
  socket.addEventListener("open", () => connected.resolve(), { once: true });
  socket.addEventListener("error", connected.reject, { once: true });
  socket.addEventListener("message", async ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.action === "send_msg") replies.push(reply(frame.params));
    if (!frame.echo) return;
    const response = frame.action === "get_group_member_info" && memberInfo ? await memberInfo(frame.params) : { message_id: 99 };
    socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: response }));
  });
  await connected.promise;
  let messageId = 0;
  return {
    socket,
    send(text: string | readonly object[], group: number | null = originalGroup, user = moderator) {
      socket.send(JSON.stringify({ self_id: account, user_id: user, group_id: group ?? undefined,
        post_type: "message", message_type: group === null ? "private" : "group", sub_type: group === null ? "friend" : "normal",
        sender: { role: "admin" }, message: text, message_id: ++messageId }));
    },
    next: () => waitFor(() => replies.shift(), "未收到 OneBot 词条回复。"),
    expectDrained() { expect(replies).toEqual([]); },
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
    const expired = join(root, "media-expired");
    await writeFile(join(root, "media-fixture.ts"), `
      const fetch = globalThis.fetch;
      const media = ${JSON.stringify(mediaBytes)};
      globalThis.fetch = async (input, options) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.hostname === "127.0.0.1") return fetch(input, options);
        if (url.hostname !== "gchat.qpic.cn" && url.hostname !== "multimedia.nt.qq.com.cn") {
          throw new Error("词条媒体夹具拒绝外部请求");
        }
        if (url.searchParams.has("stale") || await Bun.file(${JSON.stringify(expired)}).exists()) {
          return new Response(null, { status: 403 });
        }
        const kind = url.searchParams.get("kind") || "photo";
        return new Response(Uint8Array.from(media[kind]), { headers: { "Content-Type": "application/octet-stream" } });
      };
    `);
    const host = Bun.spawn([process.execPath, "--preload", "./media-fixture.ts", "app.ts"], {
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

      one.send("#添加 OneBot归档");
      expect((await one.next()).text).toContain("#结束添加");
      one.send([{ type: "image", data: { url: legacyPhoto } }]);
      one.send("    #结束添加");
      expect((await one.next()).text).toBe("添加成功：OneBot归档");

      milky.send("#添加 Milky归档");
      expect((await milky.next()).text).toContain("#结束添加");
      milky.send([
        { type: "audio", data: { resource_id: "voice", temp_url: `${mediaSource}?stale=1` } },
        { type: "video", data: { resource_id: "video" } },
      ]);
      milky.send("    #结束添加 ");
      expect((await milky.next()).text).toBe("添加成功：Milky归档");
      expect(milky.mediaQueries).toEqual(["voice", "video"]);
      const archive = JSON.parse(await readFile(groupFile, "utf8"));
      expect(archive.OneBot归档).toEqual([[{ type: "image", file: expect.stringMatching(/^77\/image\/[0-9a-f]{64}$/u) }]]);
      expect(archive.Milky归档[0].map(({ type }: { type: string }) => type)).toEqual(["record", "video"]);

      await writeFile(expired, "");
      one.send("Milky归档");
      expect((await one.next()).parts.filter(({ type }) => type !== "reply")).toEqual([
        { type: "record", data: { file: embedded("voice") } }, { type: "video", data: { file: embedded("video") } },
      ]);
      milky.send("OneBot归档");
      expect((await milky.next()).parts.filter(({ type }) => type === "image")).toEqual([
        { type: "image", data: { uri: embedded("photo"), sub_type: "normal" } },
      ]);
      expect(milky.mediaQueries).toEqual(["voice", "video"]);
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

const valkeyServer = Bun.which("valkey-server");
test.skipIf(!valkeyServer)("旧最近群按原到期时间供当前双协议和各机器人复核", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-legacy-keyword-group-"));
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const password = crypto.randomUUID();
  const url = `redis://:${password}@127.0.0.1:${port}`;
  const valkey = Bun.spawn([valkeyServer!, "--bind", "127.0.0.1", "--port", String(port), "--requirepass", password,
    "--save", "", "--appendonly", "no", "--dir", root], { stdout: "ignore", stderr: "ignore" });
  const milky = gateway();
  let connection: InstanceType<typeof Bun.RedisClient> | undefined;
  const clients: Awaited<ReturnType<typeof oneBot>>[] = [];
  let host: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    async function connect() {
      const deadline = performance.now() + 2_000;
      while (performance.now() < deadline) {
        const candidate = new Bun.RedisClient(url, { autoReconnect: false });
        try {
          await candidate.connect();
          return candidate;
        } catch {
          candidate.close();
          await Bun.sleep(10);
        }
      }
      throw new Error("隔离 Valkey 未就绪。");
    }
    const redis = connection = await connect();
    const oldKey = `Yz:group_id:${moderator}`;
    const oneKey = `lotus-yunzai:keywords:recent:${bot}:${moderator}`;
    const milkyKey = `lotus-yunzai:keywords:recent:milky:${bot}:${moderator}`;
    await redis.send("SET", [oldKey, String(originalGroup), "EX", "90"]);
    const originalExpiry = await redis.send("PEXPIRETIME", [oldKey]);
    const draftUser = 43;
    const oldDraftKey = `Yz:group_id:${draftUser}`;
    await redis.send("SET", [oldDraftKey, String(originalGroup), "EX", "90"]);
    const expiryUser = 45;
    const expiringKey = `Yz:group_id:${expiryUser}`;
    await redis.send("SET", [expiringKey, String(originalGroup), "EX", "90"]);

    await copyHost(root);
    disableMemberPrewarm(root);
    const config = join(root, "config");
    const data = join(root, "data", "messageJson");
    await mkdir(data, { recursive: true });
    await writeFile(join(config, "config/bot.yaml"), "cache_group_member: false\nonline_msg_exp: 0\n");
    await writeFile(join(config, "other.yaml"), 'master: ["100:42"]\nblackGroup: [80]\nblackUser: [44]\n');
    await writeFile(join(config, "group.yaml"), [
      "default: {groupCD: 0, singleCD: 0, addLimit: 1, addPrivate: 1, addReply: 0, addRecall: 0}",
      '"99:81": {disable: [添加消息]}', "",
    ].join("\n"));
    await writeFile(join(config, "global.yaml"), "coin_shop: {enable: false}\nscheduler: {enable: false}\n");
    await writeFile(join(config, "milky.yaml"), [
      "enable: true", "host: 127.0.0.1", `port: ${milky.server.port}`, `access_token: ${token}`,
      "ws:", "  reconnect_interval: 0.05", "  heartbeat: 0.2", "",
    ].join("\n"));
    const original = JSON.stringify({ 同一词条: [[{ type: "text", text: "旧群词条" }]] });
    const groupFile = join(data, `${originalGroup}.json`);
    await writeFile(groupFile, original);
    await writeFile(join(data, `${secondGroup}.json`), JSON.stringify({ 同一词条: [[{ type: "text", text: "现群词条" }]] }));
    host = Bun.spawn([process.execPath, "--no-env-file", "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token, LOTUS_VALKEY_URL: url },
    });
    let startup = "";
    const decoder = new TextDecoder();
    void host.stdout.pipeTo(new WritableStream({ write(chunk) { startup += decoder.decode(chunk, { stream: true }); } }));
    const endpoint = await waitFor(() => startup.includes("Lotus-Yunzai 已启动")
      ? /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(startup)?.[0] : undefined, "词条宿主未启动。");
    const queried: Record<string, unknown>[] = [];
    let role = "admin";
    const one = await oneBot(endpoint, bot, async params => {
      queried.push(params);
      if (params.user_id === expiryUser) {
        await redis.send("PEXPIRE", [expiringKey, "1"]);
        await Bun.sleep(10);
      }
      return { ...params, role };
    });
    clients.push(one);
    const secondQueries: Record<string, unknown>[] = [];
    const other = await oneBot(endpoint, 100, params => {
      secondQueries.push(params);
      return { ...params, group_id: 79, role: "owner" };
    });
    clients.push(other);
    await waitFor(() => milky.sockets[0], "Milky 测试网关未连接。");

    one.send("同一词条", null);
    expect((await one.next()).text).toBe("旧群词条");
    expect(queried).toEqual([{ group_id: originalGroup, user_id: moderator, no_cache: true }]);
    expect(await redis.get(oneKey)).toBeNull();
    expect(await redis.send("PEXPIRETIME", [oldKey])).toBe(originalExpiry);

    other.send("#词条列表", null);
    expect((await other.next()).text).toContain("请先在群内");
    expect(secondQueries).toEqual(queried);
    milky.setRole("admin", true);
    milky.send("#词条列表", { group: null });
    expect((await milky.next()).text).toContain("请先在群内");
    expect(milky.roleQueries).toEqual(queried);
    milky.setRole("member");
    milky.send("同一词条", { group: null });
    expect((await milky.next()).text).toBe("旧群词条");
    expect(await redis.get(milkyKey)).toBeNull();

    role = "member";
    one.send("#删除同一词条", null);
    expect((await one.next()).text).toContain("只有群管理员");
    expect(await readFile(groupFile, "utf8")).toBe(original);
    role = "admin";
    one.send("#添加到期草稿", null, draftUser);
    expect((await one.next()).text).toContain("#结束添加");
    await redis.send("PEXPIRE", [oldDraftKey, "1"]);
    await Bun.sleep(10);
    expect(await redis.get(oldDraftKey)).toBeNull();
    one.send("过期后不能写入", null, draftUser);
    one.send("#结束添加", null, draftUser);
    expect((await one.next()).text).toContain("添加已失效");
    expect(await readFile(groupFile, "utf8")).toBe(original);

    one.send("#词条列表", null, expiryUser);
    expect((await one.next()).text).toContain("请先在群内");
    expect(await redis.get(expiringKey)).toBeNull();
    expect(queried.at(-1)).toMatchObject({ group_id: originalGroup, user_id: expiryUser });

    one.send("#添加可写词条", null);
    expect((await one.next()).text).toContain("#结束添加");
    one.send("从旧最近群定位的内容", null);
    one.send("#结束添加", null);
    expect((await one.next()).text).toBe("添加成功：可写词条");
    const saved = JSON.parse(await readFile(groupFile, "utf8"));
    expect(saved.可写词条).toEqual([[{ type: "text", text: "从旧最近群定位的内容" }]]);
    one.send("#删除可写词条", null);
    expect((await one.next()).text).toBe("删除成功：可写词条");
    const afterDelete = JSON.parse(await readFile(groupFile, "utf8"));
    expect(afterDelete).toEqual(JSON.parse(original));

    await redis.send("SET", ["Yz:group_id:44", String(originalGroup), "EX", "90"]);
    await redis.set("Yz:group_id:46", String(originalGroup));
    const previousCount = queried.length;
    one.send("#词条列表", null, 44);
    one.send("#词条列表", null, 46);
    expect(await one.next()).toMatchObject({ user: 46, text: expect.stringContaining("请先在群内") });
    for (const group of [80, 81]) {
      await redis.send("SET", [oldKey, String(group), "KEEPTTL"]);
      one.send("#词条列表", null);
      expect((await one.next()).text).toContain("请先在群内");
    }
    expect(queried).toHaveLength(previousCount);
    expect(await redis.send("PEXPIRETIME", [oldKey])).toBe(originalExpiry);
    await redis.send("SET", [oldKey, String(originalGroup), "KEEPTTL"]);

    await redis.send("SET", [milkyKey, String(secondGroup), "EX", "90"]);
    milky.send("同一词条", { group: null });
    expect((await milky.next()).text).toBe("现群词条");
    one.send("同一词条", secondGroup);
    expect(await one.next()).toMatchObject({ group: secondGroup, text: "现群词条" });
    expect(await redis.get(oneKey)).toBe(String(secondGroup));
    one.send("同一词条", null);
    expect((await one.next()).text).toBe("现群词条");
    expect(queried).toHaveLength(previousCount);
    expect(await redis.get(oldKey)).toBe(String(originalGroup));
    expect(await redis.send("PEXPIRETIME", [oldKey])).toBe(originalExpiry);
    one.expectDrained();
  } finally {
    for (const client of clients) client.socket.close();
    milky.server.stop(true);
    connection?.close();
    host?.kill("SIGTERM");
    await host?.exited;
    valkey.kill("SIGTERM");
    await valkey.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
