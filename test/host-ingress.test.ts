import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

interface Frame {
  action: string;
  echo?: string;
  params: Record<string, unknown>;
}

test("私聊过滤先于指令派发，好友申请按旧配置通过且尊重 V3 审核", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-yunzai-trss-"));
  let host: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let client: WebSocket | undefined;
  try {
    await copyHost(root);
    await mkdir(join(root, "config/config"), { recursive: true });
    await writeFile(join(root, "config/config/other.yaml"), [
      'master: ["99:51"]', "disablePrivate: true", "disableMsg: 当前只接受账号资料",
      "disableAdopt: ['^#通行[0-9]+$']", "autoFriend: 1", "",
    ].join("\n"));
    await writeFile(join(root, "config/config/group.yaml"), "# 使用旧版群派发默认值\n");
    await writeFile(join(root, "plugins", "trss-fixture.js"), `
      export const apps = {
        files: class extends plugin {
          constructor() {
            super({ event: "message.private", rule: [{ fnc: "read" }] });
          }
          read(e) {
            if (e.file) return e.reply("文件 " + (e.file.name ?? e.file.file));
            if (/^#通行[0-9]+$|authkey=/.test(e.msg)) return e.reply("旧入口放行");
            return false;
          }
        },
        review: class extends plugin {
          constructor() { super({ event: "request.friend.add" }); }
          async accept(e) {
            if (e.comment === "manual") await e.approve(false);
          }
        },
        poke: class extends plugin {
          constructor() { super({ event: "notice.friend.poke", rule: [{ fnc: "poke" }] }); }
          poke(e) { return e.reply("旧戳一戳"); }
        },
      };
    `);
    disableMemberPrewarm(root);
    host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: "trss-fixture" },
    });
    const reader = host.stdout.getReader();
    let output = "";
    let endpoint: string | undefined;
    try {
      const decoder = new TextDecoder();
      while (!endpoint) {
        const part = await reader.read();
        if (part.done) throw new Error(`OneBot 未启动：${await new Response(host.stderr).text()}`);
        output += decoder.decode(part.value, { stream: true });
        endpoint = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(output)?.[0];
      }
    } finally {
      reader.releaseLock();
    }
    const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const socket = new BunWebSocket(endpoint, {
      headers: { Authorization: "Bearer trss-fixture", "X-Client-Role": "Universal", "X-Self-ID": "99" },
    });
    client = socket;
    const frames: Frame[] = [];
    socket.addEventListener("message", ({ data }) => frames.push(JSON.parse(data)));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });

    function send(event: object) {
      socket.send(JSON.stringify({ self_id: 99, ...event }));
    }
    async function next(timeout = 1_000): Promise<Frame> {
      const deadline = performance.now() + timeout;
      while (!frames.length && performance.now() < deadline) await Bun.sleep(5);
      const frame = frames.shift();
      if (!frame) throw new Error("没有收到 OneBot 动作。");
      return frame;
    }
    function command(message: string | object[], user_id = 42, fields: object = {}) {
      send({ post_type: "message", message_type: "private", sub_type: "friend", user_id, message, ...fields });
    }
    async function reply(expected: string | ReturnType<typeof expect.stringContaining>, fields: object = {}) {
      expect(await next()).toMatchObject({ action: "send_msg", params: { message: expected, ...fields } });
    }
    async function silence() {
      await Bun.sleep(75);
      expect(frames).toEqual([]);
    }

    command("#状态");
    await reply("当前只接受账号资料", { user_id: 42, message_type: "private" });
    command("#状态");
    await silence();
    command("#状态", 51);
    await reply(expect.stringContaining("Lotus-Yunzai 正在运行"), { user_id: 51 });
    command("#状态", 42, { message_type: "group", group_id: 77 });
    await reply(expect.stringContaining("Lotus-Yunzai 正在运行"), { group_id: 77 });
    command("#帮助", 43, { message_type: "group", group_id: 77 });
    command("#帮助");
    await reply(expect.stringContaining("Lotus-Yunzai 系统指令"), { message_type: "private", user_id: 42 });
    command("#通行12");
    await reply("旧入口放行");
    command("https://example.invalid/history?authkey=fixture");
    await reply("旧入口放行");
    command([{ type: "file", data: { file: "记录.xlsx" } }]);
    await reply("文件 记录.xlsx");
    command([{ type: "file", data: { name: "记录.json.exe" } }], 43);
    await reply("当前只接受账号资料", { user_id: 43 });
    send({ post_type: "notice", notice_type: "offline_file", user_id: 42, file: { name: "记录.JSON" } });
    await reply("文件 记录.JSON");
    const poke = { post_type: "notice", notice_type: "notify", sub_type: "poke", target_id: 99 };
    send({ ...poke, user_id: 42 });
    await reply("当前只接受账号资料", { user_id: 42 });
    send({ ...poke, user_id: 51 });
    await reply("旧戳一戳", { user_id: 51 });

    const request = { post_type: "request", request_type: "friend", user_id: 62 };
    send({ ...request, flag: 1234 });
    send({ ...request, flag: "legacy-review", comment: "manual" });
    const manual = await next();
    expect(manual).toMatchObject({ action: "set_friend_add_request", params: {
      flag: "legacy-review", approve: false, remark: "",
    } });
    send({ echo: manual.echo, status: "ok", retcode: 0 });
    const start = performance.now();
    send({ ...request, flag: "automatic" });
    send({ ...request, flag: "automatic" });
    const automatic = await next(4_500);
    expect(performance.now() - start).toBeGreaterThanOrEqual(2_900);
    expect(automatic).toMatchObject({ action: "set_friend_add_request", params: {
      flag: "automatic", approve: true, remark: "",
    } });
    send({ echo: automatic.echo, status: "ok", retcode: 0 });
    await silence();
  } finally {
    client?.close();
    if (host) {
      host.kill();
      await host.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
