import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readGroupDispatch } from "../lib/group-dispatch.ts";
import type { GroupRequest, MessageEvent } from "../lib/messages.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string> = {}) {
  const path = await mkdtemp(join(tmpdir(), "lotus-group-dispatch-"));
  temporary.push(path);
  for (const [name, content] of Object.entries(files)) {
    const file = join(path, "config", name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return readGroupDispatch(pathToFileURL(`${path}/`));
}

function message(fields: Partial<MessageEvent> = {}): MessageEvent {
  return {
    post_type: "message", message_type: "group", self_id: 10, group_id: 20, user_id: 30,
    isGroup: true, isPrivate: false, isMaster: false,
    msg: "#状态", raw_message: "#状态", message: "#状态", reply: () => true,
    ...fields,
  };
}

test("无群配置时不加冷却、去别名或启停限制，旧全角前缀归一化保留原始消息", async () => {
  const policy = await fixture();
  const event = message({ msg: "＃ 状态" });
  expect(policy.admit(event)).toBe(true);
  expect(policy.prepare(event)).toEqual({ event: { ...event, msg: "#状态" }, allowNew: true });
  expect(policy.admit(event)).toBe(true);
  expect(policy.prepare(message({ msg: "云崽#状态" })).event.msg).toBe("云崽#状态");
  expect(policy.prepare(message({ msg: "/状态" })).event.msg).toBe("/状态");
  expect(policy.prepare(message({ msg: "※ 指令" })).event.msg).toBe("*指令");
  expect(policy.allows(event, ["状态"])).toBe(true);
});

test("Lotus 平面点赞设置不启用旧群路由，也不遮挡旧目录的路由配置", async () => {
  const likes = "enable: false\nstrangeThumbUp: false\ncount: 3\n";
  const policy = await fixture({ "group.yaml": likes });
  const event = message();
  expect(policy.admit(event)).toBe(true);
  expect(policy.prepare(event).allowNew).toBe(true);
  expect(policy.admit(event)).toBe(true);
  expect(policy.allows(event, ["状态"])).toBe(true);

  const both = await fixture({ "group.yaml": likes, "config/group.yaml": "default: {enable: [状态]}" });
  expect(both.allows(event, ["状态"])).toBe(true);
  expect(both.allows(event, ["主页"])).toBe(false);
});

test.each(["# 旧空配置\n", "{}\n"])("裁剪为空的旧群配置仍启用默认群冷却和别名 %s", async (legacy) => {
  const policy = await fixture({ "group.yaml": "enable: false\ncount: 3\n", "config/group.yaml": legacy });
  const first = message({ msg: "云崽#状态", raw_message: "云崽#状态" });
  expect(policy.admit(first)).toBe(true);
  expect(policy.prepare(first).event.msg).toBe("#状态");
  expect(policy.admit(message({ user_id: 31 }))).toBe(false);
  expect(policy.admit(message({ group_id: 21 }))).toBe(true);
});

test("旧群配置的部分 default 整段覆盖内置默认值", async () => {
  const policy = await fixture({ "config/group.yaml": `
default: {onlyReplyAt: 1}
21: {botAlias: 荷花}
` });
  const first = message({ msg: "云崽#状态", raw_message: "云崽#状态" });
  expect(policy.admit(first)).toBe(true);
  expect(policy.prepare(first)).toMatchObject({ allowNew: true, event: { msg: "云崽#状态" } });
  expect(policy.admit(message({ user_id: 31 }))).toBe(true);
  expect(policy.prepare(message({ group_id: 21 })).allowNew).toBe(false);
  expect(policy.prepare(message({ group_id: 21, msg: "荷花#状态" }))).toMatchObject({
    allowNew: true, event: { msg: "#状态" },
  });
  expect(policy.keywordSettings(first)).toEqual({ addLimit: 0, addPrivate: false, addReply: false, addAt: false, addRecall: 0 });
});

test("旧群配置仅设称呼时仍按旧版要求称呼或 @", async () => {
  const policy = await fixture({ "config/group.yaml": "default: {botAlias: 荷花}\n" });
  expect(policy.prepare(message()).allowNew).toBe(false);
  expect(policy.prepare(message({ atBot: true })).allowNew).toBe(true);
});

test("全局名单兼容字符串和数字，黑名单优先且主人也受限，终端独立", async () => {
  const policy = await fixture({
    "config/other.yaml": 'whiteUser: ["30", 31]\nblackUser: ["31"]\nwhiteGroup: ["20", 21]\nblackGroup: [21]\n',
    "group.yaml": 'default: {enable: ["配置可用指令"]}',
  });
  expect(policy.admit(message())).toBe(true);
  expect(policy.admit(message({ user_id: 31, isMaster: true }))).toBe(false);
  expect(policy.admit(message({ user_id: 32 }))).toBe(false);
  expect(policy.admit(message({ group_id: 21 }))).toBe(false);
  expect(policy.admit(message({ group_id: 22 }))).toBe(false);
  expect(policy.admit(message({
    message_type: "private", isPrivate: true, isGroup: false, group_id: undefined, raw_message: "私聊状态",
  }))).toBe(true);
  const terminal = message({ message_type: "terminal", user_id: undefined, group_id: undefined });
  expect(policy.admit(terminal)).toBe(true);
  expect(policy.allows(terminal, ["状态"])).toBe(true);
});

test("群配置按四层覆盖，按准确功能名启停并且禁用优先", async () => {
  const policy = await fixture({
    "group.yaml": `default: {enable: [默认, 双重], disable: [双重]}
"10:default": {enable: [机器人, 双重]}
20: {enable: [群聊, 双重]}
"10:20": {disable: [群聊, 双重], enable: [特定, 群聊, 双重]}
`,
    "config/group.yaml": "default: {enable: [次级配置]}",
  });
  expect(policy.allows(message({ self_id: 9, group_id: 21 }), ["默认"])).toBe(true);
  expect(policy.allows(message({ group_id: 21 }), ["机器人"])).toBe(true);
  expect(policy.allows(message({ self_id: 9 }), ["群聊"])).toBe(true);
  expect(policy.allows(message(), ["特定"])).toBe(true);
  expect(policy.allows(message(), ["特定", "双重"])).toBe(false);
  expect(policy.allows(message(), ["群聊"])).toBe(false);
  expect(policy.allows(message(), ["特定扩展"])).toBe(false);
  const request: GroupRequest = {
    post_type: "request", request_type: "group", sub_type: "invite", self_id: 10, group_id: 20, user_id: 30,
    flag: "request", isGroup: true, isPrivate: false, isMaster: false,
    approve: async () => true, notifyMasters: async () => 1, reply: () => true,
  };
  expect(policy.allows(request, ["特定"])).toBe(true);
});

test("定时日历的目标遵守全局群名单及同机器人旧功能开关", async () => {
  const policy = await fixture({
    "other.yaml": "whiteGroup: [20, 21, 23]\nblackGroup: [23]\nwhiteUser: [30]\n",
    "group.yaml": '20: { enable: [AutoCalendar] }\n"10:20": { disable: [AutoCalendar] }\n',
  });
  const feature = ["[guides] 定时日历"];
  expect(policy.allowsScheduledGroup(9, 20, feature)).toBe(true);
  expect(policy.allowsScheduledGroup(10, 20, feature)).toBe(false);
  expect(policy.allowsScheduledGroup(10, 21, feature)).toBe(true);
  expect(policy.allowsScheduledGroup(10, 22, feature)).toBe(false);
  expect(policy.allowsScheduledGroup(10, 23, feature)).toBe(false);
  expect(policy.allows(message({ self_id: 9 }), ["普通活动日历"])).toBe(false);
});

test("旧助手工具配置沿用到已恢复的头像、表情、图片和日志入口", async () => {
  const policy = await fixture({
    "config/group.yaml": '20: { disable: [椰奶助手-其他] }\n21: { enable: [椰奶助手-其他] }\n',
  });
  for (const name of ["[group] 图片文字识别", "头像", "群头像", "取face", "取直链", "日志等级"]) {
    expect(policy.allows(message(), [name, "group"])).toBe(false);
    expect(policy.allows(message({ group_id: 21 }), [name, "group"])).toBe(true);
  }
  expect(policy.allows(message(), ["状态", "system"])).toBe(true);
  expect(policy.allows(message({ group_id: 21 }), ["状态", "system"])).toBe(false);
});

test("群别名和 @ 允许新命令，活动上下文的无 @ 消息仍能通过 admit", async () => {
  const policy = await fixture({
    "config/group.yaml": `default: {onlyReplyAt: 1, groupCD: 10000, singleCD: 0}
"10:default": {botAlias: "#荷花"}
"10:21": {onlyReplyAt: 2, groupCD: 0}
"10:22": {onlyReplyAt: 0, groupCD: 0}
`,
    "bot.yaml": '"/→#": true',
  });
  const followup = message({ msg: "上下文内容", raw_message: "上下文内容" });
  expect(policy.admit(followup)).toBe(true);
  expect(policy.prepare(followup)).toMatchObject({ allowNew: false, event: { msg: "上下文内容", only_reply_at: false } });
  const alias = message({ msg: "井荷花 /状态", raw_message: "井荷花 /状态", message: [{ type: "text", text: "井荷花 /状态" }] });
  expect(policy.admit(alias)).toBe(true);
  const prepared = policy.prepare(alias);
  expect(prepared).toMatchObject({ allowNew: true, event: { msg: "#状态", hasAlias: true } });
  expect(prepared.event.raw_message).toBe(alias.raw_message);
  expect(prepared.event.message).toBe(alias.message);
  expect(policy.admit(message({ user_id: 31 }))).toBe(false);
  expect(policy.prepare(message({ group_id: 21, atBot: true })).allowNew).toBe(true);
  expect(policy.prepare(message({ group_id: 21, isMaster: true })).allowNew).toBe(true);
  expect(policy.prepare(message({ group_id: 21 })).allowNew).toBe(false);
  expect(policy.prepare(message({ group_id: 22 })).allowNew).toBe(true);
  expect(policy.prepare(message({ group_id: 22, atBot: true, msg: "#荷花#状态" })).event.msg).toBe("#荷花#状态");
});

test("旧群配置继承默认冷却，群和个人冷却跨 Bot 共享，重复按群、Bot、用户、原始消息区分", async () => {
  const policy = await fixture({ "group.yaml": '20: {groupCD: 0, singleCD: 10000}\n21: {groupCD: 0, singleCD: 0}\n' });
  const first = message();
  expect(policy.admit(first)).toBe(true);
  expect(policy.prepare(first).allowNew).toBe(true);
  expect(policy.admit(message({ self_id: 11, raw_message: "变更" }))).toBe(false);
  expect(policy.admit(message({ user_id: 31 }))).toBe(true);
  expect(policy.admit(message({ group_id: 21 }))).toBe(true);
  expect(policy.admit(message({ group_id: 21, self_id: 11 }))).toBe(true);
  expect(policy.admit(message({ group_id: 21, raw_message: "变更" }))).toBe(true);
  const defaults = message({ group_id: 22, raw_message: "默认群" });
  expect(policy.admit(defaults)).toBe(true);
  policy.prepare(defaults);
  expect(policy.admit(message({ group_id: 22, self_id: 11, user_id: 32 }))).toBe(false);
  await Bun.sleep(1_020);
  expect(policy.admit(message({ group_id: 21 }))).toBe(true);
});

test("同一会话跨协议保留一秒同文去重，群与私聊及不同群互不抢占", async () => {
  const policy = await fixture({ "config/group.yaml": "default: {groupCD: 0, singleCD: 0}" });
  const privateMessage = message({
    message_type: "private", isPrivate: true, isGroup: false, group_id: undefined, message_id: 11, boundAccount: true,
  });
  expect(policy.admit(privateMessage)).toBe(true);
  expect(policy.admit(privateMessage)).toBe(false);
  expect(policy.admit({ ...privateMessage, adapter: "milky", message_id: 12 })).toBe(false);
  expect(policy.admit(message())).toBe(true);
  expect(policy.admit(message())).toBe(false);
  expect(policy.admit(message({ group_id: 21 }))).toBe(true);
  expect(policy.admit(message({ group_id: 21 }))).toBe(false);
  expect(policy.admit({ ...privateMessage, self_id: 11 })).toBe(true);
  expect(policy.admit({ ...privateMessage, user_id: 31 })).toBe(true);
  expect(policy.admit(message({ raw_message: "群先到" }))).toBe(true);
  expect(policy.admit({ ...privateMessage, raw_message: "群先到" })).toBe(true);
  await Bun.sleep(1_020);
  expect(policy.admit({ ...privateMessage, adapter: "milky" })).toBe(true);
});

test("私聊去重不抢占附件、代操作、终端或无账号事件", async () => {
  const policy = await fixture();
  const privateMessage = message({
    message_type: "private", isPrivate: true, isGroup: false, group_id: undefined, message_id: 11, boundAccount: true,
  });
  const file = { type: "file", name: "原始记录.json" };
  const excluded = [
    { ...privateMessage, isDelegated: true },
    { ...privateMessage, file, message: [{ type: "text", text: "#状态" }, file] },
    { ...privateMessage, file, message: [file], msg: "", message_id: undefined },
    { ...privateMessage, message_id: undefined },
    { ...privateMessage, boundAccount: false },
    { ...privateMessage, self_id: undefined },
    { ...privateMessage, message_type: "terminal" as const },
  ];
  for (const event of excluded) {
    expect(policy.admit(event)).toBe(true);
    expect(policy.admit(event)).toBe(true);
  }
  expect(policy.admit(privateMessage)).toBe(true);
  expect(policy.admit(privateMessage)).toBe(false);
});

test("群禁言只服从宿主提供的 Bot 状态，不使用发言人角色或原始群数据", async () => {
  const policy = await fixture();
  const event = message({ sender: { role: "owner" } });
  const muted = { ...event, botMute: { remainingSeconds: 30, isAdmin: true } };
  expect(policy.admit(muted)).toBe(false);
  const allMuted = { ...event, botMute: { allMembers: true, isAdmin: false, isOwner: false } };
  expect(policy.admit(allMuted)).toBe(false);
  const botOwner = { ...event, botMute: { ...allMuted.botMute, isOwner: true } };
  expect(policy.admit(botOwner)).toBe(true);
  const raw = { ...event, group: { all_muted: true, mute_left: 300 } };
  expect(policy.admit(raw)).toBe(true);
});
