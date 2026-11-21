import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

type Incoming = string | { type: string; data: Record<string, string | number> }[];
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
  const headers: Record<string, string> = {
    Authorization: "Bearer recall-reply-fixture", "X-Client-Role": "Universal",
  };
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

  async function take(action: string, params: object = {}) {
    if (!frames.length) await deadline(available.promise, `未收到 ${action} ${JSON.stringify(params)}。`);
    const frame = frames.shift()!;
    if (!frames.length) available = Promise.withResolvers<void>();
    expect(frame).toMatchObject({ action, params });
    return frame;
  }

  return {
    send,
    take,
    closed,
    close: () => socket.close(),
    assertNoPendingFrames: () => expect(frames).toEqual([]),
    message(message: Incoming, message_id: number, options: object = {}) {
      send({
        post_type: "message", message_type: "group", sub_type: "normal", group_id: 77,
        user_id: 51, message_id, message, ...options,
      });
    },
    async deletion(message_id: number) {
      const frame = await take("delete_msg", { message_id });
      expect(typeof frame.echo).toBe("string");
      return frame;
    },
    async quote(message_id: number, user_id: number, scope: object = { message_type: "group", group_id: 77 }) {
      const frame = await take("get_msg", { message_id });
      this.receipt(frame, "ok", 0, { message_id, self_id: botId, sender: { user_id }, message: "引用正文", ...scope });
    },
    async role(user_id: number, role: string) {
      const frame = await take("get_group_member_info", { group_id: 77, user_id, no_cache: true });
      this.receipt(frame, "ok", 0, { group_id: 77, user_id, role });
    },
    async history(user_id: number, message_seq: number, messages: readonly object[]) {
      const frame = await take("get_friend_msg_history", { user_id, message_seq, count: 10, disable_get_url: true, parse_mult_msg: false });
      this.receipt(frame, "ok", 0, { messages });
    },
    receipt(frame: Frame, status = "ok", retcode = 0, data?: object) {
      send({ echo: frame.echo, status, retcode, data });
    },
    async status() {
      send({ post_type: "message", message_type: "private", sub_type: "friend", user_id: 42, message: "#状态" });
      await take("send_msg", {
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

async function withHost(run: (open: (botId?: number) => Promise<Gateway>, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-trss-recall-reply-"));
  const gateways: Gateway[] = [];
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await writeFile(join(root, "config/config/other.yaml"), 'master: ["99:51", "100:52"]\n');
    await writeFile(join(root, "plugins/legacy-recall.js"), `
      export default class extends plugin {
        constructor() { super({ event: "message.group", rule: [{ reg: /^#撤回$/, fnc: "custom" }] }); }
        custom(e) { return e.group_id === 78 && e.reply("旧插件已处理撤回"); }
      }
    `);
    disableMemberPrewarm(root);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: "recall-reply-fixture" },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const endpoint = await deadline(endpointOf(host), "测试宿主启动超时。");
      await run(async (botId) => {
        const gateway = await connect(endpoint, botId);
        gateways.push(gateway);
        return gateway;
      }, root);
      host.kill();
      await deadline(host.exited, "测试宿主退出超时。");
      for (const gateway of gateways) {
        await deadline(gateway.closed, "测试网关断开超时。");
        gateway.assertNoPendingFrames();
      }
      expect(await stderr).not.toContain("处理 OneBot 事件失败");
    } finally {
      for (const gateway of gateways) gateway.close();
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await host.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function quoted(command: string, id: string | number): Incoming {
  return [{ type: "reply", data: { id } }, { type: "text", data: { text: command } }];
}

test("实际 OneBot 群权限取已验证的引用和成员，私聊仅撤本机器人消息", () => withHost(async (open, root) => {
  const gateway = await open(99);
  const otherBot = await open(100);
  const unbound = await open();

  gateway.message(quoted("#撤回", -703), -702, { user_id: 42, isMaster: true, sender: { role: "owner" } });
  await gateway.quote(-703, 41);
  await gateway.role(42, "member");
  await gateway.take("send_msg", { group_id: 77, message: expect.arrayContaining([{ type: "text", data: { text: expect.stringContaining("仅限群管理员") } }]) });
  otherBot.message(quoted("#撤回", -703), -702, { sender: { user_id: 51, role: "owner" }, sub_type: "anonymous" });
  otherBot.message(quoted("#撤回", -703), -702, { self_id: 99 });
  unbound.message(quoted("#撤回", -703), -702);
  await gateway.status();
  await otherBot.status();
  await unbound.status();

  gateway.message(quoted("#撤回", 705), 704, { group_id: 78 });
  await gateway.take("send_msg", { group_id: 78, message: "旧插件已处理撤回" });
  await gateway.status();

  gateway.message(quoted("#撤回", "-705"), -704);
  await gateway.quote(-705, 41);
  const target = await gateway.deletion(-705);
  gateway.receipt(target);
  const command = await gateway.deletion(-704);
  expect(command.echo).not.toBe(target.echo);
  gateway.receipt(command);
  await gateway.status();

  gateway.message("[CQ:reply,id=-707] 撤回", 706, { message_type: "private", sub_type: "friend", group_id: undefined, user_id: 42 });
  await gateway.quote(-707, 99, { message_type: "private", sub_type: "friend" });
  await gateway.history(42, -707, [{ message_type: "private", sub_type: "friend", message_id: -707, self_id: 99, user_id: 99,
    sender: { user_id: 99 } }]);
  const privateTarget = await gateway.deletion(-707);
  gateway.receipt(privateTarget);
  await gateway.status();

  gateway.message(quoted("撤回", 721), 720, { message_type: "private", sub_type: "friend", group_id: undefined });
  await gateway.quote(721, 51, { message_type: "private", sub_type: "friend", target_id: 99 });
  await gateway.status();
  gateway.message(quoted("#撤回", 723), 722, { message_type: "private", sub_type: "friend", group_id: undefined });
  await gateway.quote(723, 99, { message_type: "private", sub_type: "friend", target_id: 52 });
  await gateway.take("send_msg", { user_id: 51, message: expect.arrayContaining([{ type: "text", data: { text: expect.stringContaining("无法核实当前会话") } }]) });

  gateway.message(quoted("撤回", 725), 724, { user_id: 42 });
  await gateway.quote(725, 99);
  await gateway.role(42, "member");
  gateway.receipt(await gateway.deletion(725));
  gateway.receipt(await gateway.deletion(724));
  await gateway.status();

  const legacy = join(root, "plugins", "yenai-plugin", "config", "config");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "groupAdmin.yaml"), "recallMsgPer:\n  bot: master\n  member: owner\n");
  await writeFile(join(root, "config", "groupAdmin.yaml"), "recallMsgPer:\n  member: admin\n");
  gateway.message(quoted("#撤回", 731), 730, { user_id: 42, sender: { user_id: 42, role: "owner" } });
  await gateway.quote(731, 99);
  await gateway.role(42, "owner");
  await gateway.take("send_msg", { group_id: 77, message: expect.arrayContaining([{ type: "text", data: { text: expect.stringContaining("仅限主人") } }]) });

  gateway.message(quoted("#撤回", 733), 732, { user_id: 42 });
  await gateway.quote(733, 43);
  await gateway.role(42, "admin");
  gateway.receipt(await gateway.deletion(733));
  gateway.receipt(await gateway.deletion(732));
  await gateway.status();

  gateway.message(quoted("#撤回", 735), 734, { user_id: 42, sender: { user_id: 42, role: "admin" } });
  await gateway.quote(735, 43);
  await gateway.role(42, "member");
  await gateway.take("send_msg", { group_id: 77, message: expect.arrayContaining([{ type: "text", data: { text: expect.stringContaining("仅限群管理员") } }]) });
  await gateway.status();

  gateway.message(quoted("#撤回", 737), 736);
  await gateway.quote(737, 41, { message_type: "group", group_id: 77,
    message: [{ type: "file", data: { file: "fixture.txt", file_id: "opaque-id" } }] });
  await gateway.take("send_msg", { group_id: 77, message: expect.arrayContaining([
    { type: "text", data: { text: expect.stringContaining("无法核实引用的群文件") } },
  ]) });
  await gateway.status();

  gateway.message("#撤回", 708);
  gateway.receipt(await gateway.deletion(708));
  await gateway.status();

  otherBot.message(quoted("撤回", "-709"), -709, { user_id: 52 });
  otherBot.receipt(await otherBot.deletion(-709));
  await otherBot.status();
}), 9_000);

test("引用撤回明确拒绝或回执未知时保留命令，重复事件无写入", () => withHost(async (open) => {
  const gateway = await open(99);
  gateway.message(quoted("#撤回", -802), -801);
  await gateway.quote(-802, 41);
  const rejected = await gateway.deletion(-802);
  gateway.receipt(rejected, "failed", 1403);
  const failure = await gateway.take("send_msg", { message_type: "group", group_id: 77 });
  expect(failure.params.message).toContain("未能撤回");
  expect(failure.params.message).not.toContain("结果未确认");

  gateway.message("[CQ:reply,id=-804] 撤回", -803);
  await gateway.quote(-804, 41);
  const unknown = await gateway.deletion(-804);
  gateway.receipt(unknown, "async", 1);
  await gateway.take("send_msg", {
    message_type: "group", group_id: 77, message: expect.stringContaining("结果未确认"),
  });
  await gateway.status();
  await Bun.sleep(1_050);
  gateway.message("[CQ:reply,id=-804] 撤回", -803);
  await gateway.status();
  gateway.close();
  await gateway.closed;
  const reconnected = await open(99);
  reconnected.message("[CQ:reply,id=-804] 撤回", -803);
  await reconnected.status();
}), 9_000);

test("同时引用另一条正在处置的撤回命令时，同一消息只提交一次", () => withHost(async (open) => {
  const gateway = await open(99);
  gateway.message(quoted("#撤回", 902), 901);
  await gateway.quote(902, 41);
  const target = await gateway.deletion(902);

  // One incoming command references the held command. Another uses its pending target as its own ID.
  const overlap = quoted("撤回", 901);
  gateway.message(overlap, 903);
  gateway.message(quoted("#撤回", 904), 902);
  await gateway.status();

  gateway.receipt(target);
  gateway.receipt(await gateway.deletion(901));
  gateway.message(overlap, 903);
  await gateway.status();
}), 9_000);

test("实际 OneBot 群文件删除核对目录 ID、上传人、业务号和回执", () => withHost(async open => {
  const gateway = await open(99);
  const fileId = "/opaque-group-file";
  const directory = "folder-nested";
  function fileQuote(message_id: number, group_id = 77) {
    return gateway.quote(message_id, 43, { message_type: "group", group_id,
      message: [{ type: "file", data: { file: "原文件.txt", file_id: fileId, file_size: "15" } }] });
  }
  const entry = { group_id: 77, file_id: fileId, file_name: "改名后.txt", size: 15, uploader: 43, busid: 104 };
  async function rootFiles(data: object) {
    gateway.receipt(await gateway.take("get_group_root_files", { group_id: 77, file_count: 10_000 }), "ok", 0, data);
  }
  async function expectReply(text: string) {
    await gateway.take("send_msg", { group_id: 77, message: expect.arrayContaining([{ type: "text", data: { text } }]) });
  }

  gateway.message(quoted("#撤回", 1_002), 1_001, { user_id: 42 });
  await fileQuote(1_002);
  await gateway.role(42, "admin");
  await rootFiles({ files: [], folders: [{ group_id: 77, folder_id: directory }] });
  const listed = await gateway.take("get_group_files_by_folder", { group_id: 77, folder_id: directory, file_count: 10_000 });
  gateway.receipt(listed, "ok", 0, { files: [entry], folders: [] });
  await gateway.role(42, "admin");
  const deleting = await gateway.take("delete_group_file", { group_id: 77, file_id: fileId, busid: 104 });
  gateway.message(quoted("撤回", 1_020), 1_019);
  await fileQuote(1_020);
  await gateway.status();
  gateway.receipt(deleting, "ok", 0, {
    result: 0, transGroupFileResult: { result: { retCode: 0 }, successFileIdList: [fileId], failFileIdList: [] },
  });
  gateway.receipt(await gateway.deletion(1_001));
  await gateway.status();

  gateway.message(quoted("#撤回", 1_004), 1_003);
  await fileQuote(1_004);
  // NapCat returns an unrelated opaque directory handle, even with the same file metadata.
  await rootFiles({ files: [{ ...entry, file_id: "unrelated-handle", file_name: "原文件.txt" }], folders: [] });
  await expectReply("当前群文件目录没有可核实的对应文件。");

  gateway.message(quoted("#撤回", 1_006), 1_005);
  await fileQuote(1_006);
  await rootFiles({ files: [{ ...entry, uploader: 44 }], folders: [] });
  await expectReply("当前群文件目录没有可核实的对应文件。");

  gateway.message(quoted("#撤回", 1_008), 1_007);
  await fileQuote(1_008, 78);
  await expectReply("无法核实当前会话的引用消息。");

  gateway.message(quoted("#撤回", 1_010), 1_009, { user_id: 42, sender: { user_id: 42, role: "admin" } });
  await fileQuote(1_010);
  await gateway.role(42, "admin");
  await rootFiles({ files: [entry], folders: [] });
  await gateway.role(42, "member");
  await expectReply("该命令仅限群管理员可用。");

  const uncertain = quoted("#撤回", 1_012);
  gateway.message(uncertain, 1_011);
  await fileQuote(1_012);
  await rootFiles({ files: [entry], folders: [] });
  gateway.receipt(await gateway.take("delete_group_file", { group_id: 77, file_id: fileId, busid: 104 }), "async", 1);
  await expectReply("群文件删除结果未确认。");
  gateway.message(uncertain, 1_011);
  await gateway.status();

  gateway.message(quoted("#撤回", 1_014), 1_013);
  await fileQuote(1_014);
  await rootFiles({ files: [entry], folders: [] });
  gateway.receipt(await gateway.take("delete_group_file", { group_id: 77, file_id: fileId, busid: 104 }), "ok", 0,
    { result: 0, transGroupFileResult: { result: { retCode: 0 }, successFileIdList: [], failFileIdList: [fileId] } });
  await expectReply("未能删除群文件。");
  await gateway.status();
}), 9_000);
