import { expect, test } from "bun:test";
import { milkyMessage } from "../lib/adapters/milky-message.ts";
import { segment } from "../lib/messages.ts";

const selfId = 1001;
const senderId = 2002;
const groupId = 3003;
const seq = 404;
const text = (value: string) => ({ type: "text", data: { text: value } });
const incoming = (data: Record<string, unknown> = {}) => ({
  self_id: selfId, event_type: "message_receive",
  data: { message_scene: "friend", sender_id: senderId, peer_id: senderId, message_seq: seq, segments: [text("#状态")], ...data },
});

function fixture(result: Record<string, unknown> | undefined = { message_seq: 505 }) {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    async call(action: string, params: Record<string, unknown>) {
      calls.push({ action, params });
      return result;
    },
  };
}

test("Milky 群消息保留原文、提及和引用，并且不从事件授予权限", () => {
  const { call } = fixture();
  const event = milkyMessage(incoming({ message_scene: "group", peer_id: groupId, group_member: { role: "owner" }, segments: [
    { type: "mention", data: { user_id: selfId } },
    text("  #状态 "),
    { type: "reply", data: { message_seq: 42 } },
    { type: "mention", data: { user_id: 4004 } },
    { type: "mention_all", data: {} },
    { type: "image", data: { temp_url: "https://example.invalid/image.jpg" } },
    text("全部 "),
  ] }), selfId, call);
  expect(event).toMatchObject({
    post_type: "message", message_type: "group", sub_type: "normal", self_id: selfId, user_id: senderId, group_id: groupId,
    message_id: seq, msg: "#状态 全部", raw_message: "[at]  #状态 [reply][at][at][image]全部 ",
    atBot: true, at: "all", reply_id: "42", isGroup: true, isPrivate: false, isMaster: false, boundAccount: false,
    sender: { user_id: senderId },
    message: [
      { type: "at", qq: String(selfId) }, { type: "text", text: "  #状态 " }, { type: "reply", id: "42" },
      { type: "at", qq: "4004" }, { type: "at", qq: "all" }, { type: "image", data: { temp_url: "https://example.invalid/image.jpg" } },
      { type: "text", text: "全部 " },
    ],
  });
  expect(event?.member).toBeUndefined();
});

test("Milky 只接受同账号、可证实会话和安全整数的消息", () => {
  const { call } = fixture();
  for (const envelope of [
    { ...incoming(), self_id: undefined }, { ...incoming(), self_id: selfId + 1 }, { ...incoming(), self_id: String(selfId) },
    { ...incoming(), event_type: "message_recall" }, { ...incoming(), data: [] },
    incoming({ message_scene: "temp" }), incoming({ message_scene: "private" }), incoming({ peer_id: groupId }),
    incoming({ sender_id: selfId, peer_id: selfId }), incoming({ sender_id: 2 ** 53 }), incoming({ peer_id: 0 }),
    incoming({ message_seq: 2 ** 53 }), incoming({ segments: [] }),
    incoming({ segments: [{ type: "text", data: { text: 42 } }] }),
    incoming({ segments: [{ type: "mention", data: { user_id: 2 ** 53 } }] }),
  ]) expect(milkyMessage(envelope, selfId, call)).toBeUndefined();
  expect(milkyMessage(incoming(), Infinity, call)).toBeUndefined();
  const privateEvent = milkyMessage(incoming(), selfId, call);
  expect(privateEvent).toMatchObject({ message_type: "private", sub_type: "friend", isPrivate: true, isMaster: false });
  expect(privateEvent?.group_id).toBeUndefined();
});

test("Milky 回复按会话发出文本、提及和消息序号引用", async () => {
  const { calls, call } = fixture();
  const group = milkyMessage(incoming({ message_scene: "group", peer_id: groupId }), selfId, call);
  const friend = milkyMessage(incoming(), selfId, call);
  expect(await group?.reply(["回复", { type: "at", data: { qq: "all" } }], true, { at: true })).toBe(true);
  expect(await friend?.reply([segment.reply("88"), segment.text("收到")], true, { at: true })).toBe(true);
  expect(calls).toEqual([
    { action: "send_group_message", params: { group_id: groupId, message: [
      { type: "reply", data: { message_seq: seq } }, { type: "mention", data: { user_id: senderId } },
      text("\n"), text("回复"), { type: "mention_all", data: {} },
    ] } },
    { action: "send_private_message", params: { user_id: senderId, message: [{ type: "reply", data: { message_seq: 88 } }, text("收到")] } },
  ]);
});

test("Milky 拒绝混合不支持的回复，且要求发送结果有安全消息序号", async () => {
  const { calls, call } = fixture({});
  const event = milkyMessage(incoming({ message_scene: "group", peer_id: groupId }), selfId, call);
  expect(await event?.reply(["内容", segment.image("image.png")])).toBe(false);
  expect(await event?.reply([segment.face(1), "文本"])).toBe(false);
  expect(await event?.reply([segment.at(2 ** 53), "文本"])).toBe(false);
  expect(await event?.reply(["内容", segment.reply(" 22")])).toBe(false);
  expect(await event?.reply("内容", false, { at: "bad" })).toBe(false);
  expect(await event?.reply("内容", false, { recallMsg: 10 })).toBe(false);
  expect(await event?.reply([])).toBe(false);
  expect(calls).toEqual([]);
  expect(await event?.reply("未确认")).toBe(false);
  const throwing = milkyMessage(incoming(), selfId, async () => { throw new Error("连接关闭"); });
  expect(await throwing?.reply("没有确认")).toBe(false);
  const offline = milkyMessage(incoming(), selfId, async () => undefined);
  expect(await offline?.reply("离线")).toBe(false);
  expect(calls).toHaveLength(1);
});
