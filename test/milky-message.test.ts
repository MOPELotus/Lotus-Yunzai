import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { milkyMessage } from "../lib/adapters/milky-message.ts";
import { readQqChatFile, readQqMessageMedia } from "../lib/chat-files.ts";
import { segment, type MessageSegment, type ProtocolSegment } from "../lib/messages.ts";
import { maxPublicFileBytes } from "../lib/public-files.ts";

const selfId = 1001;
const senderId = 2002;
const groupId = 3003;
const seq = 404;
const text = (value: string) => ({ type: "text", data: { text: value } });
const incoming = (data: Record<string, unknown> = {}) => ({
  self_id: selfId, event_type: "message_receive",
  data: { message_scene: "friend", sender_id: senderId, peer_id: senderId, message_seq: seq, segments: [text("#状态")], ...data },
});

test("Milky 点赞只向当前会话发送者提交一次并等待成功回执", async () => {
  const group = incoming({ message_scene: "group", peer_id: groupId });
  const friend = fixture({ friend: { user_id: senderId } });
  expect(await milkyMessage(group, selfId, friend.call)?.isFriend?.()).toBe(true);
  expect(friend.calls).toEqual([{ action: "get_friend_info", params: { user_id: senderId, no_cache: true } }]);
  const other = fixture({ friend: { user_id: selfId } });
  expect(await milkyMessage(group, selfId, other.call)?.isFriend?.()).toBe(false);

  const confirmed = fixture({});
  const event = milkyMessage(incoming(), selfId, confirmed.call);
  expect(await event?.isFriend?.()).toBe(true);
  expect(await event?.likeSelf?.(11)).toBe(0);
  expect(await event?.likeSelf?.(3)).toBe(3);
  expect(confirmed.calls).toEqual([{ action: "send_profile_like", params: { user_id: senderId, count: 3 } }]);
  expect(await milkyMessage(group, selfId, async () => undefined)?.likeSelf?.(3)).toBe(0);
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
      { type: "at", qq: "4004" }, { type: "at", qq: "all" },
      { type: "image", url: "https://example.invalid/image.jpg", file: "https://example.invalid/image.jpg" },
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

test("Milky 只查询本会话的有效引用并核对返回的聊天身份", async () => {
  const segments = [{ type: "reply", data: { message_seq: 0 } }, text("查看引用")];
  const group = incoming({ message_scene: "group", peer_id: groupId, segments });
  const quoted = {
    message_scene: "group", peer_id: groupId, message_seq: 0, sender_id: 4004,
    segments: [text("引用"), { type: "image", data: { temp_url: "https://example.invalid/old.png" } }],
  };
  const valid = fixture({ message: quoted });
  const event = milkyMessage(group, selfId, valid.call);
  expect(valid.calls).toEqual([]);
  const [first, second] = await Promise.all([event?.lookupReply?.(), event?.lookupReply?.()]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({ user_id: 4004, message: [{ type: "text", text: "引用" },
    { type: "image", url: "https://example.invalid/old.png" }] });
  expect(valid.calls).toEqual([{ action: "get_message", params: { message_scene: "group", peer_id: groupId, message_seq: 0 } }]);
  for (const override of [{ peer_id: 5005 }, { message_scene: "friend" }, { message_seq: 1 }, { sender_id: 0 }]) {
    const other = fixture({ message: { ...quoted, ...override } });
    expect(await milkyMessage(group, selfId, other.call)?.lookupReply?.()).toBeUndefined();
  }
  const privateResult = fixture({ message: { ...quoted, message_scene: "friend", peer_id: senderId, sender_id: selfId } });
  expect(await milkyMessage(incoming({ segments }), selfId, privateResult.call)?.lookupReply?.()).toMatchObject({ user_id: selfId });
  expect(privateResult.calls[0]?.params).toEqual({ message_scene: "friend", peer_id: senderId, message_seq: 0 });
  expect(milkyMessage(incoming(), selfId, privateResult.call)?.lookupReply).toBeUndefined();
});

test("Milky 用当前图片、语音和视频的资源 ID 按需续取临时链接", async () => {
  const segments = [
    { type: "image", data: { resource_id: "current-image" } },
    { type: "audio", data: { resource_id: "current-audio", temp_url: "https://example.invalid/old.silk" } },
    { type: "video", data: { resource_id: "current-video" } },
  ];
  const url = "https://example.invalid/current.png";
  const valid = fixture({ url });
  const event = milkyMessage(incoming({ segments }), selfId, valid.call);
  const parts = Array.isArray(event?.message) ? event.message : [];
  expect(valid.calls).toEqual([]);
  expect(parts.map(({ type }) => type)).toEqual(["image", "record", "video"]);
  expect(parts[1]?.url).toBe("https://example.invalid/old.silk");
  for (const part of parts) {
    const read = part.getDownloadUrl;
    if (typeof read !== "function") throw new Error("Milky 媒体缺少按需下载入口");
    expect(await Promise.all([read(), read()])).toEqual([url, url]);
  }
  expect(valid.calls).toEqual(segments.map(({ data }) => ({
    action: "get_resource_temp_url", params: { resource_id: data.resource_id },
  })));
  const bad = fixture({ url: "file:///tmp/test.png" });
  const invalid = milkyMessage(incoming({ segments }), selfId, bad.call);
  const invalidRead = (Array.isArray(invalid?.message) ? invalid.message[0] : undefined)?.getDownloadUrl;
  expect(typeof invalidRead === "function" && await invalidRead()).toBeUndefined();
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
  expect(await event?.reply([segment.face("not-an-id"), "文本"])).toBe(false);
  expect(await event?.reply([segment.at(2 ** 53), "文本"])).toBe(false);
  expect(await event?.reply(["内容", segment.reply(" 22")])).toBe(false);
  expect(await event?.reply("内容", false, { at: "bad" })).toBe(false);
  expect(await event?.reply([])).toBe(false);
  expect(calls).toEqual([]);
  expect(await event?.reply("未确认")).toBe(false);
  const throwing = milkyMessage(incoming(), selfId, async () => { throw new Error("连接关闭"); });
  expect(await throwing?.reply("没有确认")).toBe(false);
  const offline = milkyMessage(incoming(), selfId, async () => undefined);
  expect(await offline?.reply("离线")).toBe(false);
  expect(calls).toHaveLength(1);
});

test("Milky 只安排撤回已确认的原会话回复", async () => {
  const recalls: unknown[] = [];
  const group = incoming({ message_scene: "group", peer_id: groupId });
  const event = milkyMessage(group, selfId, fixture().call, (...args) => { recalls.push(args); });
  expect(await event?.reply("内容", true, { recallMsg: 0.5 })).toBe(true);
  expect(await event?.reply("内容", false, { recallMsg: 121 })).toBe(true);
  const unknown = milkyMessage(group, selfId, async () => undefined, (...args) => { recalls.push(args); });
  expect(await unknown?.reply("内容", false, { recallMsg: 5 })).toBe(false);
  expect(recalls).toEqual([["recall_group_message", { group_id: groupId, message_seq: 505 }, 0.5]]);
});

test("Milky 图片保留可用的临时链接和显示数据，不公开无效地址", () => {
  const { call, calls } = fixture();
  const first = "https://images.example.invalid/photo.png?signature=x";
  const second = "http://images.example.invalid/sticker.jpg";
  const event = milkyMessage(incoming({ segments: [
    text("原文 "),
    { type: "image", data: {
      temp_url: first, resource_id: "opaque-id", width: 640, height: 480, summary: "图片", sub_type: "normal",
    } },
    { type: "image", data: {
      temp_url: "https://name:token@images.example.invalid/a.png", width: -1, height: 2 ** 31, summary: "不安全\n", sub_type: "unknown",
    } },
    { type: "image", data: { temp_url: "file:///tmp/a.png" } },
    { type: "image", data: { temp_url: second, sub_type: "sticker", url: "https://wrong.example.invalid" } },
  ] }), selfId, call);
  expect(event).toMatchObject({ msg: "原文", raw_message: "原文 [image][image][image][image]", img: [first, second] });
  expect(event?.message).toEqual([
    { type: "text", text: "原文 " },
    { type: "image", file: first, url: first, resource_id: "opaque-id", width: 640, height: 480,
      summary: "图片", sub_type: "normal", getDownloadUrl: expect.any(Function) },
    { type: "image" }, { type: "image" }, { type: "image", file: second, url: second, sub_type: "sticker" },
  ]);
  expect(calls).toEqual([]);
});

test("Milky 图片回复按字节视图编码，保留 HTTP(S) 地址并规范 Base64 补位", async () => {
  const { calls, call } = fixture();
  const view = Uint8Array.of(255, 1, 2, 255).subarray(1, 3);
  const buffer = Buffer.from([99, 3, 4, 99]).subarray(1, 3);
  const remote = "http://images.example.invalid/a.png?preview=1";
  const event = milkyMessage(incoming(), selfId, call);
  expect(await event?.reply(["图片", segment.image(view), segment.image(buffer), segment.image("base64://BQ"), {
    type: "image", data: { url: remote },
  }])).toBe(true);
  expect(calls).toEqual([{ action: "send_private_message", params: {
    user_id: senderId,
    message: [
      text("图片"),
      ...["base64://AQI=", "base64://AwQ=", "base64://BQ==", remote].map((uri) =>
        ({ type: "image", data: { uri, sub_type: "normal" } })),
    ],
  } }]);
});

test("Milky 图片拒绝本地路径、凭据、畸形编码和超出共享字节上限的批次", async () => {
  const { calls, call } = fixture();
  const event = milkyMessage(incoming(), selfId, call);
  for (const file of [
    "/tmp/a.png", "file:///tmp/a.png", "https://account:secret@images.example.invalid/a.png",
    "https://@images.example.invalid/a.png", "https://images.example.invalid\\a.png",
    "base64://", "base64://A", "base64://AQ=I", "base64://AQI==", "base64://AB==", new Uint8Array(),
    new Uint8Array(maxPublicFileBytes + 1),
  ]) expect(await event?.reply(["内容", segment.image(file)])).toBe(false);
  const oversizedUri = "base64://" + "A".repeat(Math.ceil(maxPublicFileBytes / 3) * 4 + 4);
  expect(await event?.reply(segment.image(oversizedUri))).toBe(false);
  const nearlyFull = new Uint8Array(maxPublicFileBytes - 1);
  expect(await event?.reply([segment.image(nearlyFull), segment.record("base64://AQI=")])).toBe(false);
  expect(await event?.reply({
    type: "video", data: { file: nearlyFull, thumb_uri: "base64://AQI=" },
  })).toBe(false);
  expect(calls).toEqual([]);
});

test("Milky 接收表情、语音和视频，保留安全的临时链接和媒体信息", () => {
  const { calls, call } = fixture();
  const voice = "https://media.example.invalid/voice?temporary=1";
  const video = "http://media.example.invalid/video.mp4";
  const event = milkyMessage(incoming({ segments: [
    text("媒体 "),
    { type: "face", data: { face_id: "00014", is_large: true } },
    { type: "face_incoming", data: { face_id: 0 } },
    { type: "record", data: { resource_id: "voice-1", temp_url: voice, duration: 5 } },
    { type: "video", data: { resource_id: "video-1", temp_url: video, duration: 8, width: 640, height: 480 } },
    { type: "audio", data: { temp_url: "https://name:secret@media.example.invalid/voice", duration: 2 ** 31 } },
    { type: "video", data: { temp_url: "file:///tmp/private.mp4", width: -1, duration: 0 } },
  ] }), selfId, call);
  expect(event).toMatchObject({ msg: "媒体", raw_message: "媒体 [face][face][record][video][record][video]" });
  expect(event?.img).toBeUndefined();
  expect(event?.message).toEqual([
    { type: "text", text: "媒体 " },
    { type: "face", id: "14", is_large: true },
    { type: "face", id: "0" },
    { type: "record", resource_id: "voice-1", url: voice, file: voice, duration: 5, getDownloadUrl: expect.any(Function) },
    { type: "video", resource_id: "video-1", url: video, file: video, duration: 8, width: 640, height: 480,
      getDownloadUrl: expect.any(Function) },
    { type: "record" },
    { type: "video", duration: 0 },
  ]);
  expect(calls).toEqual([]);
  expect(milkyMessage(incoming({ segments: [{ type: "face", data: { face_id: "1e2" } }] }), selfId, call))
    .toBeUndefined();
});

test("QQ 聊天媒体下载只访问已知源和原始字节，保持普通文件的主机范围", async () => {
  const fetch = globalThis.fetch;
  const calls: string[] = [];
  const bytes = Uint8Array.of(255, 216, 255, 224);
  globalThis.fetch = (async (input, options) => {
    calls.push(String(input));
    expect(options).toMatchObject({ redirect: "error", credentials: "omit" });
    if (String(input).includes("wrong-response")) return new Response('{"message":"expired"}', {
      headers: { "Content-Type": "application/octet-stream" },
    });
    return new Response(bytes, { headers: { "Content-Type": "image/jpeg" } });
  }) as typeof globalThis.fetch;
  const recent = "https://multimedia.nt.qq.com.cn/download?fixture=1";
  const earlier = "https://gchat.qpic.cn/gchatpic_new/fixture/0";
  try {
    expect(await readQqMessageMedia(recent)).toEqual(Buffer.from(bytes));
    expect(await readQqMessageMedia(earlier)).toEqual(Buffer.from(bytes));
    expect(await readQqMessageMedia(`${recent}&wrong-response=1`)).toBeUndefined();
    expect(await readQqChatFile(earlier)).toBeUndefined();
    expect(await readQqMessageMedia("https://gchat.qpic.cn/other")).toBeUndefined();
    expect(await readQqMessageMedia("https://qq.com.invalid/download")).toBeUndefined();
    expect(await readQqMessageMedia("https://name:fixture@multimedia.nt.qq.com.cn/download")).toBeUndefined();
    expect(await readQqMessageMedia(recent, AbortSignal.abort())).toBeUndefined();
    expect(calls).toEqual([recent, earlier, `${recent}&wrong-response=1`]);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("Milky 回复发送规范表情编号、语音地址和独立视频缩略图", async () => {
  const { calls, call } = fixture();
  const voice = "https://media.example.invalid/voice";
  const video = "https://media.example.invalid/video";
  const videoBytes = Buffer.from([99, 3, 4, 99]).subarray(1, 3);
  const event = milkyMessage(incoming(), selfId, call);
  expect(await event?.reply([
    segment.face("00014"),
    { type: "face", data: { id: 0, is_large: false } },
    segment.record(voice),
    segment.video(videoBytes),
    { type: "video", data: { file: video, thumb_uri: "base64://BQ" } },
  ])).toBe(true);
  expect(calls).toEqual([{ action: "send_private_message", params: {
    user_id: senderId,
    message: [
      { type: "face", data: { face_id: "14" } },
      { type: "face", data: { face_id: "0", is_large: false } },
      { type: "record", data: { uri: voice } },
      { type: "video", data: { uri: "base64://AwQ=" } },
      { type: "video", data: { uri: video, thumb_uri: "base64://BQ==" } },
    ],
  } }]);
});

test("Milky 拒绝带非法表情编号、语音、视频或缩略图的整条回复", async () => {
  const { calls, call } = fixture();
  const event = milkyMessage(incoming(), selfId, call);
  const invalid: readonly (MessageSegment | ProtocolSegment)[] = [
    segment.face(2 ** 53), segment.face("+12"),
    segment.record("/tmp/voice.mp3"), segment.video("https://user:token@media.example.invalid/video"),
    { type: "face", data: { id: 12, is_large: "true" } },
    { type: "video", data: { file: "https://media.example.invalid/video", thumb_uri: "file:///tmp/image.png" } },
  ];
  for (const part of invalid) expect(await event?.reply(["内容", part])).toBe(false);
  expect(calls).toEqual([]);
});

test("Milky 合并转发以登录 QQ 为节点发送者，按原顺序提交一次普通消息", async () => {
  const reply = fixture();
  const forward = fixture();
  const group = milkyMessage(incoming({ message_scene: "group", peer_id: groupId }), selfId, reply.call, undefined, forward.call);
  const friend = milkyMessage(incoming(), selfId, reply.call, undefined, forward.call);
  expect(await group?.forward?.(["第一条", [segment.face(14), "第二条", segment.record(Uint8Array.of(4, 5))]])).toBe(true);
  expect(await friend?.forward?.(["私聊节点"])).toBe(true);
  expect(reply.calls).toEqual([]);
  expect(forward.calls).toEqual([
    { action: "send_group_message", params: { group_id: groupId, message: [{ type: "forward", data: { messages: [
      { user_id: selfId, sender_name: "Lotus-Yunzai", segments: [text("第一条")] },
      { user_id: selfId, sender_name: "Lotus-Yunzai", segments: [
        { type: "face", data: { face_id: "14" } }, text("第二条"), { type: "record", data: { uri: "base64://BAU=" } },
      ] },
    ] } }] } },
    { action: "send_private_message", params: { user_id: senderId, message: [{ type: "forward", data: { messages: [
      { user_id: selfId, sender_name: "Lotus-Yunzai", segments: [text("私聊节点")] },
    ] } }] } },
  ]);
});

test("Milky 合并转发整体校验节点和共享媒体上限", async () => {
  const { calls, call } = fixture();
  const event = milkyMessage(incoming(), selfId, call, undefined, call);
  expect(await event?.forward?.([])).toBe(false);
  expect(await event?.forward?.(["前一条", []])).toBe(false);
  expect(await event?.forward?.(["前一条", segment.image("/tmp/local.png")])).toBe(false);
  expect(await event?.forward?.(Array(101).fill("节点"))).toBe(false);
  expect(await event?.forward?.([
    segment.image(new Uint8Array(maxPublicFileBytes - 1)), segment.video("base64://AQI="),
  ])).toBe(false);
  expect(calls).toEqual([]);
  expect(await event?.forward?.(Array(100).fill("节点"))).toBe(true);
  expect(calls).toHaveLength(1);
});

test("Milky 合并转发区分明确失败和发送结果未知", async () => {
  const { call } = fixture();
  const ordinary = milkyMessage(incoming(), selfId, call);
  expect(ordinary?.forward).toBeUndefined();

  const rejected = milkyMessage(incoming(), selfId, call, undefined, async () => undefined);
  expect(await rejected?.forward?.(["节点"])).toBe(false);

  for (const result of [{}, { message_seq: 2 ** 53 }, { message_seq: "12" }]) {
    const uncertain = milkyMessage(incoming(), selfId, call, undefined, async () => result);
    await expect(uncertain!.forward!(["节点"])).rejects.toThrow("合并转发结果未确认");
  }
  const error = new Error("发送结果未知");
  const lost = milkyMessage(incoming(), selfId, call, undefined, async () => { throw error; });
  await expect(lost!.forward!(["节点"])).rejects.toBe(error);
});
