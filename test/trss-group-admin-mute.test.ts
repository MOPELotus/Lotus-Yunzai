import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindMessageGroupActions } from "../lib/adapters/group-moderation.ts";
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
  const role = user_id === milkyId || (user_id === oneBotId && group_id === 82) ? "owner" :
    [oneBotId, operator, 53].includes(Number(user_id)) ? "admin" : "member";
  return { group_id: user_id === 45 ? 80 : group_id, user_id, role };
}

test("预检期间关机时当前会话不能继续禁言", async () => {
  const requested = Promise.withResolvers<void>();
  let active = true;
  let sent = 0;
  const actions = bindMessageGroupActions({
    bot: 99, actor: 51, signal: new AbortController().signal, accepting: () => active, isMaster: () => true,
    isProtected: () => false, async role(id) {
      if (id === 42) await requested.promise;
      return id === 99 ? "admin" : "member";
    },
    async mute() { sent++; return "confirmed"; },
    async wholeMute() { sent++; return "confirmed"; },
    async kick() { sent++; return "confirmed"; },
    async title() { sent++; return "confirmed"; },
    async setAdmin() { sent++; return "confirmed"; },
  });
  const held = actions.groupMute(42, 300);
  active = false;
  requested.resolve();
  expect(await held).toBe("unavailable");
  expect(sent).toBe(0);
});

test("双协议群管理复核名单、成员权限和各项网关回执", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-group-mute-wire-"));
  const milkyCalls: Call[] = [];
  const rosterChanges = new Map<string, "admin" | "member">();
  const activity = (group_id: number, bot: number) => {
    const joined = Math.floor(Date.now() / 1000) - 3600;
    return [
      { group_id, user_id: bot, role: "member", join_time: joined, last_sent_time: joined },
      { group_id, user_id: operator, role: "admin", join_time: joined, last_sent_time: joined },
      { group_id, user_id: 42, role: "member", card: "从未发言夹具", join_time: joined, last_sent_time: joined },
      { group_id, user_id: 54, role: "member", card: "已有活动夹具", join_time: joined, last_sent_time: joined + 10 },
    ];
  };
  function member(params: Call["params"]) {
    const baseline = liveMember(params);
    return { ...baseline, role: rosterChanges.get(`${params.group_id}:${params.user_id}`) ?? baseline.role };
  }
  function updateRole(params: Call["params"], enabled: unknown) {
    rosterChanges.set(`${params.group_id}:${params.user_id}`, enabled === true ? "admin" : "member");
  }
  const milky = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
      const action = new URL(request.url).pathname.split("/").at(-1)!;
      const params = await request.json() as Call["params"];
      milkyCalls.push({ action, params });
      if ((action === "set_group_member_mute" && params.user_id === 44) ||
          (action === "kick_group_member" && params.user_id === 44) ||
          (action === "set_group_member_admin" && params.user_id === 60044) ||
          (action === "set_group_whole_mute" && params.is_mute === false)) return new Response(null, { status: 503 });
      if (action === "set_group_member_admin") updateRole(params, params.is_set);
      const data = action === "get_login_info" ? { uin: milkyId } : action === "get_group_member_info" ?
        { member: member(params) } : action === "send_group_message" ? { message_seq: milkyCalls.length }
        : action === "get_group_info" ? { group: { group_id: params.group_id, member_count: params.group_id === 85 ? 5 : 4 } }
        : action === "get_group_member_list" ? { members: activity(Number(params.group_id), milkyId) } : {};
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
    await writeFile(join(root, "config/other.yaml"), 'master: ["100:51", "99:52"]\nmasterQQ: [52]\n');
    await writeFile(join(root, "config/group.yaml"), "default: {groupCD: 0, singleCD: 0}\n78: {disable: [椰奶群管-基础]}\n80: {disable: [椰奶群管-黑白名单]}\n81: {disable: [椰奶群管-违禁词]}\n");
    const legacyDirectory = join(root, "plugins/yenai-plugin/config/config");
    await mkdir(legacyDirectory, { recursive: true });
    const legacyList = join(legacyDirectory, "groupAdmin.yaml");
    await writeFile(legacyList, "# 原群管配置\nblackQQ: [52, 57]\nwhiteQQ: [59] # 白名单\nnoBan: false\n");
    const legacyRules = join(root, "plugins/yenai-plugin/config/group");
    await mkdir(legacyRules, { recursive: true });
    const testRules = JSON.stringify({ muteTime: 45, bannedWords: {
      合成违禁测试: { matchType: 1, penaltyType: 5 },
      合成踢黑测试: { matchType: 2, penaltyType: 6 },
    } });
    await writeFile(join(legacyRules, "79.json"), testRules);
    await writeFile(join(legacyRules, "81.json"), testRules);
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
    const nowSeconds = () => Math.floor(Date.now() / 1000);
    client.onmessage = ({ data }) => {
      const { action, params, echo } = JSON.parse(data);
      oneBotCalls.push({ action, params });
      if (action === "set_group_admin") updateRole(params, params.enable);
      const denied = action === "set_group_ban" && params.group_id === 82 && params.user_id === 44;
      const reply = action === "get_group_member_info" ? member(params)
        : action === "send_msg" ? { message_id: oneBotCalls.length }
        : action === "get_group_shut_list" ? [
          { uin: "43", cardName: "合成群名片", nick: "合成昵称", role: 2, shutUpTime: nowSeconds() + 81 },
          { uin: "44", nick: "另一个群成员", role: 3, shutUpTime: nowSeconds() + 120 },
          { uin: "45", nick: "已过期", role: 2, shutUpTime: nowSeconds() - 1 },
        ] : action === "get_group_info" ? { group_id: params.group_id, member_count: params.group_id === 85 ? 5 : 4 }
        : action === "get_group_member_list" ? activity(Number(params.group_id), oneBotId) : {};
      if (echo) client.send(JSON.stringify({ echo, status: denied ? "failed" : "ok", retcode: denied ? 100 : 0, data: reply }));
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

    send(oneBotMessage("#全体禁言"));
    expect(JSON.stringify((await oneBotReply(6)).params.message)).toContain("禁言");
    send(oneBotMessage("#全员解禁"));
    expect(JSON.stringify((await oneBotReply(7)).params.message)).toContain("已关闭全体禁言");
    send(oneBotMessage("#全员禁言", 54));
    expect(JSON.stringify((await oneBotReply(8)).params.message)).toContain("管理权限");
    expect(oneBotCalls.filter(({ action }) => action === "set_group_whole_ban").map(({ params }) => params)).toEqual([
      { group_id: group, enable: true }, { group_id: group, enable: false },
    ]);

    await webhook("message_receive", milkyMessage("#全员禁言"));
    expect(JSON.stringify((await milkyReply(4)).params.message)).toContain("禁言");
    const wholeUnknown = milkyMessage("#全体解禁");
    await webhook("message_receive", wholeUnknown);
    expect(JSON.stringify((await milkyReply(5)).params.message)).toContain("未确认");
    await webhook("message_receive", wholeUnknown);
    await webhook("message_receive", milkyMessage("#解禁42"));
    await milkyReply(6);
    expect(milkyCalls.filter(({ action }) => action === "set_group_whole_mute").map(({ params }) => params)).toEqual([
      { group_id: group, is_mute: true }, { group_id: group, is_mute: false },
    ]);

    send(oneBotMessage("#踢42"));
    expect(JSON.stringify((await oneBotReply(9)).params.message)).toContain("42");
    send(oneBotMessage("#踢黑53"));
    await oneBotReply(10);
    send(oneBotMessage("#踢黑52"));
    await oneBotReply(11);
    expect(oneBotCalls.filter(({ action }) => action === "set_group_kick").map(({ params }) => params)).toEqual([
      { group_id: group, user_id: 42, reject_add_request: false },
    ]);
    await webhook("message_receive", milkyMessage("#踢黑55"));
    expect(JSON.stringify((await milkyReply(7)).params.message)).toContain("55");
    const kickUnknown = milkyMessage("#踢44");
    await webhook("message_receive", kickUnknown);
    expect(JSON.stringify((await milkyReply(8)).params.message)).toContain("未确认");
    await webhook("message_receive", kickUnknown);
    await webhook("message_receive", milkyMessage("#解禁56"));
    await milkyReply(9);
    expect(milkyCalls.filter(({ action }) => action === "kick_group_member").map(({ params }) => params)).toEqual([
      { group_id: group, user_id: 55, reject_add_request: true },
      { group_id: group, user_id: 44, reject_add_request: false },
    ]);
    const list = async () => Bun.YAML.parse(await readFile(legacyList, "utf8"));
    expect(await list()).toEqual({ blackQQ: [52, 57, 55], whiteQQ: [59], noBan: false });
    expect(await readFile(legacyList, "utf8")).toContain("# 白名单");

    send(oneBotMessage("#群管加黑名单58", 54));
    expect(JSON.stringify((await oneBotReply(12)).params.message)).toContain("没有编辑群管黑名单的权限");
    send(oneBotMessage("#群管加黑名单58"));
    await oneBotReply(13);
    expect(await list()).toEqual({ blackQQ: [52, 57, 55, 58], whiteQQ: [59], noBan: false });
    const repeated = oneBotMessage("其他群发言", 55, 79);
    send(repeated);
    expect(JSON.stringify((await oneBotReply(14)).params.message)).toContain("已踢出黑名单用户55");
    send(repeated);
    send(oneBotMessage("受保护的旧主人", 52, 79));
    send(oneBotMessage("本群关闭名单", 55, 80));

    const oneBotApply = { post_type: "request", request_type: "group", sub_type: "add",
      self_id: oneBotId, user_id: 57, group_id: 79, flag: "managed-list" };
    client.send(JSON.stringify(oneBotApply));
    client.send(JSON.stringify(oneBotApply));
    const applied = await waitUntil(() => oneBotCalls.find(({ action }) => action === "set_group_add_request"),
      "OneBot 未拒绝群管名单中的申请。");
    expect(applied.params).toEqual({ flag: "managed-list", sub_type: "add", approve: false, reason: "" });
    await webhook("group_member_increase", { group_id: 79, user_id: 58 });
    expect(JSON.stringify((await milkyReply(10)).params.message)).toContain("检测到黑名单58入群");
    const milkyApply = { group_id: 79, initiator_id: 57, notification_seq: 777, is_filtered: true };
    await webhook("group_join_request", milkyApply);
    await webhook("group_join_request", milkyApply);
    expect((await waitUntil(() => milkyCalls.find(({ action }) => action === "reject_group_request"),
      "Milky 未拒绝群管名单中的申请。")).params).toEqual({
      group_id: 79, notification_seq: 777, is_filtered: true, notification_type: "join_request", reason: "",
    });
    send(oneBotMessage("#群管删黑名单55"));
    await oneBotReply(15);
    send(oneBotMessage("已从名单移除", 55, 79));
    send(oneBotMessage("#解禁42"));
    await oneBotReply(16);
    expect(await list()).toEqual({ blackQQ: [52, 57, 58], whiteQQ: [59], noBan: false });
    expect(oneBotCalls.filter(({ action }) => action === "set_group_kick").map(({ params }) => params)).toEqual([
      { group_id: group, user_id: 42, reject_add_request: false }, { group_id: 79, user_id: 55, reject_add_request: false },
    ]);
    expect(oneBotCalls.filter(({ action }) => action === "set_group_add_request")).toHaveLength(1);
    expect(milkyCalls.filter(({ action }) => action === "reject_group_request")).toHaveLength(1);
    expect(milkyCalls.filter(({ action }) => action === "kick_group_member").at(-1)?.params).toEqual({ group_id: 79, user_id: 58 });

    const now = Math.floor(Date.now() / 1000);
    const ban = { post_type: "notice", notice_type: "group_ban", sub_type: "ban", self_id: oneBotId,
      group_id: 79, user_id: 59, operator_id: 53, duration: 300, time: now };
    client.send(JSON.stringify(ban));
    await Bun.sleep(40);
    expect(oneBotMuted().filter(({ user_id }) => user_id === 59)).toEqual([]);
    send(oneBotMessage("#群管加白名单61"));
    expect(JSON.stringify((await oneBotReply(17)).params.message)).toContain("加入群管白名单");
    send(oneBotMessage("#开启白名单自动解禁"));
    expect(JSON.stringify((await oneBotReply(18)).params.message)).toContain("没有设置白名单自动解禁的权限");
    await webhook("message_receive", milkyMessage("#开启白名单自动解禁"));
    expect(JSON.stringify((await milkyReply(11)).params.message)).toContain("已开启白名单自动解禁");
    expect(await list()).toEqual({ blackQQ: [52, 57, 58], whiteQQ: [59, 61], noBan: true });

    const freshBan = { ...ban, time: now + 1 };
    client.send(JSON.stringify(freshBan));
    client.send(JSON.stringify(freshBan));
    expect(JSON.stringify((await oneBotReply(19)).params.message)).toContain("已解除白名单用户的禁言");
    client.send(JSON.stringify({ ...freshBan, operator_id: 52 }));
    client.send(JSON.stringify(freshBan));
    client.send(JSON.stringify({ ...ban, group_id: 80, time: now + 2 }));
    client.send(JSON.stringify({ ...ban, operator_id: 52, time: now + 3 }));
    client.send(JSON.stringify({ ...ban, operator_id: oneBotId, time: now + 4 }));
    client.send(JSON.stringify({ ...ban, user_id: 61, duration: 0, sub_type: "lift_ban", time: now + 6 }));
    client.send(JSON.stringify({ ...ban, user_id: 61, time: now + 5 }));
    client.send(JSON.stringify({ ...ban, user_id: 0, time: now + 7 }));
    const milkyBan = { group_id: 79, user_id: 61, operator_id: 53, duration: 300 };
    expect((await webhook("group_mute", milkyBan)).status).toBe(200);
    expect(JSON.stringify((await milkyReply(12)).params.message)).toContain("已解除白名单用户的禁言");
    expect((await webhook("group_mute", { ...milkyBan, operator_id: operator })).status).toBe(200);
    await webhook("message_receive", milkyMessage("#关闭白名单解禁"));
    expect(JSON.stringify((await milkyReply(13)).params.message)).toContain("已关闭白名单自动解禁");
    expect(await list()).toEqual({ blackQQ: [52, 57, 58], whiteQQ: [59, 61], noBan: false });
    expect(oneBotMuted().filter(({ user_id }) => user_id === 59 || user_id === 61)).toEqual([
      { group_id: 79, user_id: 59, duration: 0 },
    ]);
    expect(milkyCalls.filter(({ action, params }) => action === "set_group_member_mute" && params.user_id === 61)
      .map(({ params }) => params)).toEqual([{ group_id: 79, user_id: 61, duration: 0 }]);

    const censored = oneBotMessage("合成违禁测试", 42, 79);
    send(censored);
    const censoredReply = JSON.stringify((await oneBotReply(20)).params.message);
    expect(censoredReply).toContain("触发违禁词：合成****");
    expect(censoredReply).toContain("禁言45秒、撤回消息");
    send(censored);
    send(oneBotMessage("合成违禁测试", 53, 79));
    send(oneBotMessage("合成违禁测试", 59, 79));
    send(oneBotMessage("合成违禁测试", 42, 81));

    const kickByRule = { ...milkyMessage("开头 合成踢黑测试 结尾"),
      peer_id: 79, sender_id: 43, group_member: { group_id: 79, user_id: 43, role: "member" } };
    expect((await webhook("message_receive", kickByRule)).status).toBe(200);
    expect(JSON.stringify((await milkyReply(14)).params.message)).toContain("踢出群聊、加入黑名单");
    expect(await list()).toEqual({ blackQQ: [52, 57, 58, 43], whiteQQ: [59, 61], noBan: false });
    await webhook("message_receive", kickByRule);
    const failedByRule = { ...milkyMessage("合成违禁测试"), peer_id: 79, sender_id: 44,
      group_member: { group_id: 79, user_id: 44, role: "member" } };
    await webhook("message_receive", failedByRule);
    expect(JSON.stringify((await milkyReply(15)).params.message)).toContain("禁言45秒结果未确认、撤回消息");
    await webhook("message_receive", failedByRule);
    await Bun.sleep(40);
    expect(oneBotMuted().filter(({ duration }) => duration === 45)).toEqual([
      { group_id: 79, user_id: 42, duration: 45 },
    ]);
    expect(oneBotCalls.filter(({ action }) => action === "delete_msg").map(({ params }) => params)).toEqual([
      { message_id: censored.message_id },
    ]);
    expect(milkyCalls.filter(({ action }) => action === "recall_group_message").map(({ params }) => params)).toEqual([
      { group_id: 79, message_seq: failedByRule.message_seq },
    ]);
    expect(milkyCalls.filter(({ action, params }) => action === "kick_group_member" && params.user_id === 43)).toHaveLength(1);
    expect(milkyCalls.filter(({ action, params }) => action === "set_group_member_mute" && params.duration === 45)).toHaveLength(1);
    expect(await readFile(join(legacyRules, "79.json"), "utf8")).toBe(testRules);

    const groupReplyWith = (value: string) => waitUntil(() => oneBotReplies().find(({ params }) =>
      JSON.stringify(params.message).includes(value)), `OneBot 未回复预期的群管理结果：${value}`);
    send(oneBotMessage("#申请头衔旅人", 42, 82));
    await groupReplyWith("已将你的头衔更换为「旅人」");
    send(oneBotMessage("#申请头衔不能设置", 42, 79));
    await groupReplyWith("请核对群成员和群主权限");
    send(oneBotMessage([text("#修改头衔不能代改"), at(42)], 51, 82));
    await groupReplyWith("没有设置该群头衔的权限");
    send(oneBotMessage([text("#设置头衔同行者"), at(42)], 52, 82));
    await groupReplyWith("同行者");
    expect(oneBotCalls.filter(({ action }) => action === "set_group_special_title").map(({ params }) => params)).toEqual([
      { group_id: 82, user_id: 42, special_title: "旅人" }, { group_id: 82, user_id: 42, special_title: "同行者" },
    ]);

    const milkyTitle = (message: string, sender_id = operator) => ({
      ...milkyMessage(message), peer_id: 79, sender_id, group_member: { group_id: 79, user_id: sender_id, role: sender_id === operator ? "admin" : "member" },
    });
    await webhook("message_receive", milkyTitle("#增加头衔屏蔽词云游"));
    expect(JSON.stringify((await milkyReply(16)).params.message)).toContain("云游");
    await webhook("message_receive", milkyTitle("#我要头衔云游", 42));
    expect(JSON.stringify((await milkyReply(17)).params.message)).toContain("头衔包含屏蔽词");
    await webhook("message_receive", milkyTitle("#我要头衔云游者", 42));
    expect(JSON.stringify((await milkyReply(18)).params.message)).toContain("云游者");
    await webhook("message_receive", milkyTitle("#切换头衔屏蔽词匹配模式"));
    expect(JSON.stringify((await milkyReply(19)).params.message)).toContain("模糊");
    await webhook("message_receive", milkyTitle("#申请头衔云游者", 42));
    expect(JSON.stringify((await milkyReply(20)).params.message)).toContain("头衔包含屏蔽词");
    await webhook("message_receive", milkyTitle("#我要头衔云游者"));
    expect(JSON.stringify((await milkyReply(21)).params.message)).toContain("云游者");
    await webhook("message_receive", milkyTitle("#申请头衔", 42));
    await milkyReply(22);
    expect(milkyCalls.filter(({ action }) => action === "set_group_member_special_title").map(({ params }) => params)).toEqual([
      { group_id: 79, user_id: 42, special_title: "云游者" }, { group_id: 79, user_id: operator, special_title: "云游者" },
      { group_id: 79, user_id: 42, special_title: "" },
    ]);
    const titles = JSON.parse(await readFile(join(root, "data/group/banned-words/79.json"), "utf8"));
    expect(titles).toEqual({ ...JSON.parse(testRules), TitleBannedWords: ["云游"], TitleFilterModeChange: 1 });
    expect(await readFile(join(legacyRules, "79.json"), "utf8")).toBe(testRules);

    const promote = oneBotMessage([text("#设置管理"), at(42), at(60042), at(42)], 52, 82);
    send(promote);
    await groupReplyWith("60042");
    send(promote);
    const priorAdminReplies = oneBotReplies().length;
    send(oneBotMessage("#设置管理60042", 52, 82));
    await oneBotReply(priorAdminReplies + 1);
    send(oneBotMessage("#取消管理60042", 51, 82));
    await oneBotReply(priorAdminReplies + 2);
    expect(oneBotCalls.filter(({ action }) => action === "set_group_admin").map(({ params }) => params)).toEqual([
      { group_id: 82, user_id: 42, enable: true }, { group_id: 82, user_id: 60042, enable: true },
    ]);

    const unknownAdmin = milkyTitle("#设置管理60044");
    await webhook("message_receive", unknownAdmin);
    expect(JSON.stringify((await milkyReply(23)).params.message)).toContain("未确认");
    await webhook("message_receive", unknownAdmin);
    const demote = milkyTitle("#取消管理");
    await webhook("message_receive", { ...demote, segments: [...demote.segments, { type: "mention", data: { user_id: 53 } }] });
    expect(JSON.stringify((await milkyReply(24)).params.message)).toContain("53");
    expect(milkyCalls.filter(({ action }) => action === "set_group_member_admin").map(({ params }) => params)).toEqual([
      { group_id: 79, user_id: 60044, is_set: true }, { group_id: 79, user_id: 53, is_set: false },
    ]);

    send(oneBotMessage("#查看禁言列表", 54, 82));
    const firstList = await waitUntil(() => oneBotCalls.find(({ action }) => action === "send_group_forward_msg"),
      "OneBot 禁言列表未转发。");
    expect(firstList.params.group_id).toBe(82);
    const forwarded = JSON.stringify(firstList.params.messages);
    expect(forwarded).toContain("https://q1.qlogo.cn/g?b=qq&s=100&nk=43");
    expect(forwarded).toContain("合成群名片");
    expect(forwarded).toContain("禁言剩余时间");
    expect(forwarded).toContain("禁言到期时间");
    expect(forwarded).not.toContain("已过期");

    send(oneBotMessage("#解除全部禁言", 54, 82));
    await groupReplyWith("没有解除群禁言的权限");
    const unmuteMany = oneBotMessage("#解除全部禁言", 52, 82);
    send(unmuteMany);
    const unmuteReply = await groupReplyWith("已解除 1 人的禁言");
    expect(JSON.stringify(unmuteReply.params.message)).toContain("1 人的解禁被协议端拒绝");
    send(unmuteMany);
    await webhook("message_receive", milkyTitle("#获取禁言列表"));
    expect(JSON.stringify((await milkyReply(25)).params.message)).toContain("禁言列表");
    expect(oneBotMuted().filter(({ group_id }) => group_id === 82)).toEqual([
      { group_id: 82, user_id: 43, duration: 0 },
      { group_id: 82, user_id: 44, duration: 0 },
    ]);
    expect(oneBotCalls.filter(({ action }) => action === "get_group_shut_list").map(({ params }) => params)).toEqual([
      { group_id: 82 }, { group_id: 82 },
    ]);

    send(oneBotMessage("#查看从未发言过的人", operator, 84));
    const oneBotActivity = await waitUntil(() => oneBotCalls.find(({ action, params }) =>
      action === "send_group_forward_msg" && params.group_id === 84), "OneBot 未转发群活跃情况。");
    const display = JSON.stringify(oneBotActivity.params.messages);
    expect(display).toContain("从未发言夹具");
    expect(display).toContain("https://q1.qlogo.cn/g?b=qq&s=100&nk=42");
    expect(display).not.toContain("已有活动夹具");
    send(oneBotMessage("#查看从未发言的人", 54, 84));
    send(oneBotMessage("#查看从未发言过的人第1页", operator, 85));
    await webhook("message_receive", { ...milkyTitle("#查看从未发言的人"), peer_id: 84,
      group_member: { group_id: 84, user_id: operator, role: "admin" } });
    const milkyActivity = await waitUntil(() => milkyCalls.find(({ action, params }) =>
      action === "send_group_message" && params.group_id === 84 && JSON.stringify(params.message).includes("从未发言夹具")),
    "Milky 未转发群活跃情况。");
    expect(JSON.stringify(milkyActivity.params.message)).not.toContain("已有活动夹具");
    expect(oneBotCalls.filter(({ action }) => action === "send_group_forward_msg")).toHaveLength(2);
    expect(oneBotCalls.filter(({ action, params }) => action === "get_group_member_list" && params.group_id === 84)
      .every(({ params }) => params.no_cache === true)).toBe(true);
  } finally {
    socket?.close();
    host?.kill();
    await host?.exited;
    milky.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 14_000);
