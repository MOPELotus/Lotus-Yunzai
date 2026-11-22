import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("双协议继承旧点赞和状态配置，主人聊天修改即时作用于这两个功能", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-mention-like-wire-"));
  const milkyCalls: Action[] = [];
  let milkyFriends: unknown = [{ user_id: target }];
  const milky = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const action = new URL(request.url).pathname.split("/").at(-1)!;
      const params = await request.json() as Record<string, unknown>;
      milkyCalls.push({ action, params });
      const data = action === "get_login_info" ? { uin: 100 }
        : action === "get_group_member_info" ? { member: { group_id: params.group_id, user_id: params.user_id, role: "member" } }
          : action === "get_friend_info" ? (params.user_id === target ? { friend: { user_id: target } } : {})
            : action === "get_friend_list" ? { friends: milkyFriends } : { message_seq: 1 };
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
    const previous = join(root, "plugins/yenai-plugin/config/config");
    await mkdir(previous, { recursive: true });
    const legacy = join(previous, "thumbUp.yaml");
    const legacyStatus = join(previous, "state.yaml");
    const status = join(root, "config/system-status.yaml");
    const legacySettings = [
      "count: 7", "strangeThumbUp: false", 'closeTips: "旧配置已关闭点赞"',
      'successMsg: "{{at}} {{userId}} 收到 {{thumbUpNum}} 次"', 'failsMsg: "当前点赞失败"',
      'noFriendMsg: "当前账号无法评价该资料卡"',
    ].join("\n") + "\n";
    const primary = join(root, "config/group.yaml");
    const override = "count: 3\ndefault: {groupCD: 0, singleCD: 0}\n78: {disable: [椰奶点赞]}\n";
    await writeFile(legacy, "enable: false\n" + legacySettings);
    await writeFile(legacyStatus, "# 旧状态配置\ndefaultState: true\nnoPro: true\n");
    await writeFile(primary, override);
    await writeFile(join(root, "config/other.yaml"), "master: ['99:51', '100:51']\n");
    await writeFile(join(root, "config/bot.yaml"), "file_watch: false\n");
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
    let oneBotFriends: unknown = [{ user_id: target }];
    client.onmessage = ({ data }) => {
      const { action, params, echo } = JSON.parse(data);
      oneBotCalls.push({ action, params });
      if (!echo) return;
      const value = action === "get_group_member_info"
        ? { group_id: params.user_id === target ? group : 12345, user_id: params.user_id, role: "member" }
        : action === "get_friend_list" ? oneBotFriends : { message_id: 4 };
      client.send(JSON.stringify({ echo, status: "ok", retcode: 0, data: value }));
    };
    await waitFor(() => client.readyState === WebSocket.OPEN || undefined, "OneBot 点赞测试连接未就绪。");
    let sequence = 2;
    function send(message: unknown, group_id = group, user_id = sender) {
      client.send(JSON.stringify({ self_id: 99, user_id, group_id, post_type: "message",
        message_type: "group", sub_type: "normal", message_id: ++sequence, raw_message: String(sequence), message }));
    }
    const webhook = (event_type: string, data: object) => fetch(new URL("/milky", http), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ self_id: 100, time: 1_700_000_000, event_type, data }),
      signal: AbortSignal.timeout(2_000),
    });
    const sendMilky = (message_seq: number, segments: object[]) => webhook("message_receive", {
      time: 1_700_000_000, sender_id: sender, peer_id: group, message_seq, message_scene: "group", segments,
    });
    await waitFor(async () => (await webhook("fixture", {})).status === 200 || undefined, "Milky 点赞测试连接未就绪。");
    send([{ type: "text", data: { text: "#赞我" } }]);
    await waitFor(() => oneBotCalls.find(call => call.action === "send_msg" && textOf(call).includes("旧配置已关闭点赞")),
      "OneBot 未继承旧点赞关闭配置。");
    expect((await sendMilky(9, [{ type: "text", data: { text: "#赞我" } }])).status).toBe(200);
    await waitFor(() => milkyCalls.find(call => call.action === "send_group_message" && textOf(call).includes("旧配置已关闭点赞")),
      "Milky 未继承旧点赞关闭配置。");
    expect(oneBotCalls.some(call => call.action === "send_like")).toBe(false);
    expect(milkyCalls.some(call => call.action === "send_profile_like")).toBe(false);
    await writeFile(legacy, "enable: true\n" + legacySettings);
    const milkyRepliesBefore = milkyCalls.length;
    expect((await sendMilky(10, [{ type: "text", data: { text: "#点赞" } }])).status).toBe(200);
    await waitFor(() => milkyCalls.slice(milkyRepliesBefore).find(call => call.action === "send_group_message" &&
      textOf(call).includes("当前账号无法评价该资料卡")), "Milky 未继承旧好友限制和原反馈。");
    expect(milkyCalls.some(call => call.action === "send_profile_like")).toBe(false);
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

    expect((await sendMilky(11, [
      { type: "text", data: { text: "赞Ta" } }, { type: "mention", data: { user_id: target } },
    ])).status).toBe(200);
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
    expect(await readFile(primary, "utf8")).toBe(override);
    expect(await readFile(legacy, "utf8")).toBe("enable: true\n" + legacySettings);

    await writeFile(legacy, "enable: true\n" + legacySettings.replace("strangeThumbUp: false", "strangeThumbUp: true")
      .replace("收到 {{thumbUpNum}} 次", "收到 {{thumbUpNum}} 次{{noFriend:，可以添加{userId}为好友}}"));
    oneBotFriends = [];
    milkyFriends = [];
    send([command, mention(target)]);
    await waitFor(() => oneBotCalls.find(call => textOf(call).includes("3 次，可以添加42为好友")),
      "OneBot 未用真实非好友关系展开提示。");
    expect((await sendMilky(12, [command, { type: "mention", data: { user_id: target } }])).status).toBe(200);
    await waitFor(() => milkyCalls.find(call => textOf(call).includes("3 次，可以添加42为好友")),
      "Milky 未用真实非好友关系展开提示。");

    oneBotFriends = [{}];
    milkyFriends = [{}];
    const oneBotBefore = oneBotCalls.length;
    const milkyBefore = milkyCalls.length;
    send([command, mention(target)]);
    const unresolvedOnebot = await waitFor(() => oneBotCalls.slice(oneBotBefore).find(call => textOf(call).includes("42 收到 3 次")),
      "OneBot 好友关系未知时须照常回执。");
    expect((await sendMilky(13, [
      { type: "text", data: { text: "#赞她" } }, { type: "mention", data: { user_id: target } },
    ])).status).toBe(200);
    const unresolvedMilky = await waitFor(() => milkyCalls.slice(milkyBefore).find(call => call.action === "send_group_message"),
      "Milky 好友关系未知时须照常回执。");
    expect(textOf(unresolvedMilky)).toContain("42 收到 3 次");
    expect(textOf(unresolvedOnebot)).not.toContain("可以添加");
    expect(textOf(unresolvedMilky)).not.toContain("可以添加");
    expect(oneBotCalls.filter(call => call.action === "send_like")).toHaveLength(3);
    expect(milkyCalls.filter(call => call.action === "send_profile_like")).toHaveLength(3);

    const text = (value: string) => ({ type: "text", data: { text: value } });
    async function commandOneBot(value: string, response: string, user = sender) {
      const start = oneBotCalls.length;
      send([text(value)], group, user);
      return waitFor(() => oneBotCalls.slice(start).find(call => textOf(call).includes(response)), `OneBot ${value} 未收到 ${response}`);
    }
    async function commandMilky(value: string, response: string) {
      const start = milkyCalls.length;
      expect((await sendMilky(++sequence, [text(value)])).status).toBe(200);
      return waitFor(() => milkyCalls.slice(start).find(call => textOf(call).includes(response)), `Milky ${value} 未收到 ${response}`);
    }
    sequence += 100;
    const card = await commandOneBot("#设置", "Lotus-Yunzai 设置");
    expect(textOf(card)).toContain("陌生人点赞 已开启");
    expect(textOf(card)).toContain("默认状态 已开启");
    await commandOneBot("状态", "Lotus-Yunzai 正在运行");
    await commandOneBot("#设置状态关闭", "暂无权限", 44);
    expect(await Bun.file(status).exists()).toBe(false);
    await commandMilky("#设置状态关闭", "默认状态 已关闭");
    expect(Bun.YAML.parse(await readFile(status, "utf8"))).toEqual({ defaultState: false });
    const disabledStart = oneBotCalls.length;
    send([text("状态")]);
    await commandOneBot("#帮助", "https://www.lotusshared.cn/yunzai/");
    expect(oneBotCalls.slice(disabledStart).map(textOf).join("\n")).not.toContain("Lotus-Yunzai 正在运行");
    await commandOneBot("#设置状态开启", "默认状态 已开启");
    await commandMilky("状态", "Lotus-Yunzai 正在运行");
    expect(await readFile(legacyStatus, "utf8")).toBe("# 旧状态配置\ndefaultState: true\nnoPro: true\n");

    oneBotFriends = [];
    milkyFriends = [];
    await commandOneBot("#设置陌生人点赞关闭", "陌生人点赞 已关闭");
    await commandMilky("#给我点赞", "当前账号无法评价该资料卡");
    expect(milkyCalls.filter(call => call.action === "send_profile_like")).toHaveLength(3);
    await commandMilky("#设置陌生人点赞开启", "陌生人点赞 已开启");
    await commandOneBot("#我要点赞", "收到 3 次");
    expect(oneBotCalls.filter(call => call.action === "send_like")).toHaveLength(4);
    expect(Bun.YAML.parse(await readFile(primary, "utf8"))).toMatchObject({ count: 3, strangeThumbUp: true });
    await commandOneBot("#设置渲染精度100", "没有全局渲染精度设置");
  } finally {
    socket?.close();
    host?.kill("SIGKILL");
    await host?.exited;
    milky.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
