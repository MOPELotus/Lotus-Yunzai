import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyHost, disableMemberPrewarm } from "./host-fixture.ts";

const bot = 901;
const otherBot = 902;
const owner = 701;
const peer = 702;
const otherOwner = 703;
const group = 801;
const time = 1_700_000_000;
const token = "onebot-legacy-signals-fixture";

type Trace = { name: string; event: Record<string, unknown> };
type Call = { action: string; params: Record<string, unknown>; echo?: string };

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const end = performance.now() + 4_000;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await Bun.sleep(10);
  } while (performance.now() < end);
  throw new Error(label);
}

async function endpoint(stream: ReadableStream<Uint8Array>) {
  let stdout = "";
  for await (const chunk of stream) {
    stdout += new TextDecoder().decode(chunk);
    if (stdout.includes("Lotus-Yunzai 已启动")) {
      const url = /ws:\/\/127\.0\.0\.1:\d+\/OneBotv11/u.exec(stdout)?.[0];
      if (url) return url;
    }
  }
  throw new Error("测试宿主未完成启动。\n" + stdout);
}

async function connect(url: string, id: number, calls: Call[]) {
  const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new Socket(url, { headers: {
    Authorization: `Bearer ${token}`, "X-Client-Role": "Universal", "X-Self-ID": String(id),
  } });
  socket.addEventListener("message", ({ data }) => {
    const frame: Call = JSON.parse(data);
    calls.push(frame);
    if (!frame.echo) return;
    let response: unknown = { message_id: calls.length, user_id: id };
    if (frame.action === "get_group_member_info") response = { user_id: peer, group_id: group, role: "member", nickname: "已核身份" };
    if (frame.action === "get_friend_list") response = [{ user_id: owner }, { user_id: peer }, { user_id: otherOwner }];
    socket.send(JSON.stringify({ echo: frame.echo, status: "ok", retcode: 0, data: response }));
  });
  await waitFor(() => socket.readyState === WebSocket.OPEN ? true : undefined, "OneBot 未连接。");
  return socket;
}

test("OneBot 头衔、收到点赞、输入及离线走固定旧路径并保留主人隔离", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-v3-onebot-signal-"));
  let oneBot: WebSocket | undefined;
  let other: WebSocket | undefined;
  try {
    await copyHost(root);
    disableMemberPrewarm(root);
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "other.yaml"), `master: ["${bot}:${owner}", "${otherBot}:${otherOwner}"]\ndisablePrivate: true\n`);
    await writeFile(join(root, "config", "bot.yaml"), "cache_group_member: false\nonline_msg_exp: 0\n");
    await writeFile(join(root, "plugins", "onebot-legacy-signals.js"), `
      import { appendFileSync } from "node:fs";
      function record(name, { post_type, notice_type, sub_type, self_id, user_id, group_id, event_type, end, status_text,
          message, operator_id, operator_nick, times, title, tag }) {
        appendFileSync("./trace.ndjson", JSON.stringify({ name, event: { post_type, notice_type, sub_type,
          self_id, user_id, group_id, event_type, end, status_text, message, operator_id, operator_nick, times, title, tag } }) + "\\n");
      }
      export const apps = Object.fromEntries([
        "notice.group.title", "notice.friend.profile_like", "notice.group.honor",
        "internal.input.input_status", "system.offline",
      ].map((name, i) => ["fixture" + i, class extends plugin {
        constructor() { super({ event: name }); }
        init() {
          if (i !== 0) return;
          const removed = event => record("必须移除", event);
          Bot.on("internal", removed);
          Bot.off("internal", removed);
          Bot.on("internal.input.input_status", event => record("exact", event));
          Bot.once("internal.input", event => record("once", event));
          Bot.on("system.offline.undefined", event => record("suffix", event));
          Bot.on("system.offline", event => record("offline", event));
        }
        accept(e) { record(name, e); }
      }]));
    `);
    const host = Bun.spawn([process.execPath, "app.ts"], {
      cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, LOTUS_ONEBOT_PORT: "0", LOTUS_ONEBOT_TOKEN: token },
    });
    const stderr = new Response(host.stderr).text();
    try {
      const url = await endpoint(host.stdout);
      const calls: Call[] = [], otherCalls: Call[] = [];
      const socket = oneBot = await connect(url, bot, calls);
      other = await connect(url, otherBot, otherCalls);
      const notify = (notice_type: string, fields: Record<string, unknown>) =>
        socket.send(JSON.stringify({ post_type: "notice", notice_type, self_id: bot, time, ...fields }));
      const read = async () => {
        const file = Bun.file(join(root, "trace.ndjson"));
        return await file.exists() ? (await file.text()).trim().split("\n").map(line => JSON.parse(line) as Trace) : [];
      };

      notify("notify", { sub_type: "title", user_id: peer, group_id: group, title: "原头衔" });
      const title = await waitFor(async () => (await read()).find(row => row.name === "notice.group.title"), "未收到头衔事件。");
      expect(title.event).toMatchObject({ post_type: "notice", notice_type: "group", sub_type: "title",
        self_id: bot, group_id: group, user_id: peer, title: "原头衔" });
      expect(await waitFor(() => calls.find(call => call.action === "get_group_member_info"), "未请求原成员资料。"))
        .toMatchObject({ params: { group_id: group, user_id: peer, no_cache: true } });
      notify("notify", { sub_type: "title", user_id: peer, group_id: group, title: "" });
      await waitFor(async () => (await read()).find(row => row.event.title === ""), "空头衔未保留。");

      notify("notify", { sub_type: "profile_like", operator_id: peer, operator_nick: "来源昵称", times: 3 });
      const like = await waitFor(async () => (await read()).find(row => row.name === "notice.friend.profile_like"), "未收到资料卡点赞。");
      expect(like.event).toMatchObject({ post_type: "notice", notice_type: "friend", sub_type: "profile_like",
        operator_id: peer, user_id: peer, operator_nick: "来源昵称", times: 3 });

      notify("notify", { sub_type: "honor", user_id: peer, group_id: group, honor_type: "talkative" });
      notify("notify", { sub_type: "input_status", user_id: peer, event_type: 1, status_text: "非私聊", group_id: group });
      notify("notify", { sub_type: "input_status", user_id: peer, event_type: 1, status_text: "外账号", group_id: 0, self_id: otherBot });
      notify("notify", { sub_type: "input_status", user_id: peer, event_type: 1, status_text: "对方正在输入", group_id: 0 });
      notify("notify", { sub_type: "input_status", user_id: peer, event_type: 2, status_text: "", group_id: 0 });
      const inputs = await waitFor(async () => {
        const matching = (await read()).filter(row => row.name === "exact" || row.name === "once");
        return matching.length >= 3 ? matching : undefined;
      }, "未处理完整输入状态。");
      expect(inputs.map(row => [row.name, row.event.post_type, row.event.group_id, row.event.end, row.event.message])).toEqual([
        ["exact", "internal", 0, false, "对方正在输入"],
        ["once", "internal", 0, false, "对方正在输入"],
        ["exact", "internal", 0, true, "对方结束输入..."],
      ]);

      notify("bot_offline", { user_id: peer, message: "非当前账号", tag: "不投递" });
      expect(calls.filter(call => call.action === "send_msg")).toEqual([]);
      for (let n = 0; n < 2; n++) notify("bot_offline", { user_id: bot, tag: "账号退出", message: "会话已结束 token=fixture-private" });
      const sent = await waitFor(() => calls.find(call => call.action === "send_msg"), "未收到离线主人通知。");
      expect(sent.params).toMatchObject({ user_id: owner, message_type: "private", message: "[901] 账号退出：会话已结束 token=[已隐藏]" });
      await Bun.sleep(80);
      expect(calls.filter(call => call.action === "send_msg")).toHaveLength(1);
      expect(otherCalls.filter(call => call.action === "send_msg")).toEqual([]);
      expect((await read()).map(row => row.name)).toEqual([
        "notice.group.title", "notice.group.title", "notice.friend.profile_like", "exact", "once", "exact", "suffix", "offline",
      ]);
      expect((await read()).at(-1)?.event).toMatchObject({
        post_type: "system", notice_type: "offline", self_id: bot, user_id: bot,
        tag: "账号退出", message: "会话已结束 token=[已隐藏]",
      });
    } finally {
      oneBot?.close();
      other?.close();
      if (host.exitCode === null && host.signalCode === null) host.kill();
      await host.exited;
    }
    expect(await stderr).not.toContain("处理 OneBot 事件失败");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
