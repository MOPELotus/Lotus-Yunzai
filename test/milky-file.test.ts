import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getMilkyFileCorrelation, milkyFriendFileUpload, milkyMessage } from "../lib/adapters/milky-message.ts";
import { maxChatFileBytes } from "../lib/chat-files.ts";
import { readPrivateAccess } from "../lib/private-access.ts";

const selfId = 1001;
const senderId = 2002;
const groupId = 3003;
const hash = "opaque-TriSHA1-42";
const fileId = "opaque/file-record.5";

function file(data: Record<string, unknown> = {}) {
  return { type: "file", data: { file_id: fileId, file_name: "记录归档.json", file_size: 301, ...data } };
}

function envelope(scene: "friend" | "group", ...segments: unknown[]) {
  return {
    self_id: selfId, event_type: "message_receive",
    data: { message_scene: scene, sender_id: senderId, peer_id: scene === "group" ? groupId : senderId, message_seq: 1, segments },
  };
}

function upload(data: Record<string, unknown> = {}) {
  return {
    self_id: selfId, event_type: "friend_file_upload",
    data: { ...file({ file_hash: hash }).data, user_id: senderId, is_self: false, ...data },
  };
}

function fixture(result?: Record<string, unknown>) {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  async function call(action: string, params: Record<string, unknown>) {
    calls.push({ action, params });
    return result;
  }
  return { calls, call };
}

test("Milky 保留文件 ID、实际文件名和大小，好友下载按原会话延迟查询", async () => {
  const downloadUrl = "https://files.example.invalid/f?access=opaque";
  const { calls, call } = fixture({ download_url: downloadUrl });
  const second = file({ file_id: "empty-receipt", file_name: "空文件.txt", file_size: 0 });
  const event = milkyMessage(envelope("friend", { type: "text", data: { text: "说明 " } },
    file({ file_hash: hash }), second), selfId, call);
  if (!event || typeof event.message === "string") throw new Error("缺少文件事件。");
  expect(event.raw_message).toBe("说明 [file][file]");
  expect(event.msg).toBe("说明");
  expect(event.file).toBe(event.message[1]);
  expect(event.file).toMatchObject({ type: "file", file: fileId, name: "记录归档.json", size: 301 });
  expect(event.message[2]).toEqual({ type: "file", file: "empty-receipt", name: "空文件.txt", size: 0 });
  expect(JSON.stringify(event)).not.toContain(hash);
  expect(calls).toEqual([]);
  const download = event.file?.getDownloadUrl;
  if (typeof download !== "function") throw new Error("缺少好友文件下载能力。");
  expect(await download()).toBe(downloadUrl);
  expect(calls).toEqual([{
    action: "get_private_file_download_url", params: { user_id: senderId, file_id: fileId, file_hash: hash },
  }]);
});

test("Milky 群文件只查询原群，忽略无效下载地址及失败回执", async () => {
  for (const url of [undefined, "/tmp/secret", "file:///tmp/secret", "https://user:secret@files.example.invalid/f",
    "https://files.example.invalid\\f", "https://files.example.invalid/f"]) {
    const { calls, call } = fixture({ download_url: url });
    const event = milkyMessage(envelope("group", file({ file_hash: hash })), selfId, call);
    const download = event?.file?.getDownloadUrl;
    if (typeof download !== "function") throw new Error("缺少群文件下载能力。");
    expect(await download()).toBe(url === "https://files.example.invalid/f" ? url : undefined);
    expect(calls).toEqual([{ action: "get_group_file_download_url", params: { group_id: groupId, file_id: fileId } }]);
    expect(JSON.stringify(event)).not.toContain(hash);
  }
  const failed = milkyMessage(envelope("group", file()), selfId, async () => { throw new Error("未确认"); });
  const download = failed?.file?.getDownloadUrl;
  if (typeof download !== "function") throw new Error("缺少群文件下载能力。");
  expect(await download()).toBeUndefined();
  const noHash = milkyMessage(envelope("friend", file({ file_hash: "有\n换行" })), selfId, fixture().call);
  expect(noHash?.file).toEqual({ type: "file", file: fileId, name: "记录归档.json", size: 301 });
});

test("Milky 拒绝缺少真实文件名或其他必填字段的文件消息", () => {
  const { calls, call } = fixture();
  for (const fields of [
    { file_id: "looks-like-record.txt", file_name: undefined }, { file_name: "" }, { file_name: " " },
    { file_name: ".." }, { file_name: "../looks-like-record.txt" }, { file_name: "bad\\record.txt" },
    { file_name: "bad\nrecord.txt" }, { file_id: "" }, { file_id: "bad id" },
    { file_size: -1 }, { file_size: 2 ** 53 }, { file_size: "10" },
  ]) {
    const event = envelope("friend", { type: "text", data: { text: "#帮助" } }, file(), file(fields));
    expect(milkyMessage(event, selfId, call)).toBeUndefined();
  }
  expect(calls).toEqual([]);
});

test("Milky 私聊文件放行使用真实扩展名和全部文件段", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-milky-file-test-"));
  try {
    const config = join(root, "config");
    await mkdir(config);
    await writeFile(join(config, "other.yaml"), 'disablePrivate: true\ndisableMsg: ""\n');
    const access = await readPrivateAccess(pathToFileURL(`${root}/`));
    const { call, calls } = fixture();
    const simulate = (...segments: unknown[]) => milkyMessage(envelope("friend", ...segments), selfId, call);
    const allowed = simulate(file({ file_id: "opaque.exe", file_name: "记录.json" }), file({ file_name: "表格.xlsx" }));
    const denied = simulate(file(), file({ file_id: "fake.txt", file_name: "程序.exe" }));
    if (!allowed || !denied) throw new Error("缺少文件事件。");
    expect(await access.blocked(allowed)).toBe(false);
    expect(await access.blocked(denied)).toBe(true);
    expect(calls).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("私聊限制热读取旧配置，解析失败时保留当前限制", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-private-policy-"));
  try {
    const legacy = join(root, "config", "config");
    await mkdir(legacy, { recursive: true });
    const file = join(legacy, "other.yaml");
    await writeFile(file, "disablePrivate: false\n");
    const url = pathToFileURL(`${root}/`);
    const live = await readPrivateAccess(url, undefined, true);
    const frozen = await readPrivateAccess(url);
    const { call } = fixture();
    const incoming = (text: string) => {
      const event = milkyMessage(envelope("friend", { type: "text", data: { text } }), selfId, call);
      if (!event) throw new Error("缺少好友消息。");
      return event;
    };
    const normal = incoming("普通私聊");
    const poke = { isMaster: false, reply: () => true as const };
    expect(await live.blocked(normal)).toBe(false);

    await writeFile(file, 'disablePrivate: true\ndisableMsg: ""\ndisableAdopt: ["^夹具放行$"]\n');
    await Bun.sleep(1_050);
    expect(await Promise.all([live.blocked(normal), live.blockedPoke(poke)])).toEqual([true, true]);
    expect(await live.blocked(incoming("夹具放行"))).toBe(false);
    expect(await frozen.blocked(normal)).toBe(false);

    await writeFile(file, 'disablePrivate: true\ndisableAdopt: ["("]\n');
    await Bun.sleep(1_050);
    expect(await live.blocked(normal)).toBe(true);
    expect(await live.blocked(incoming("夹具放行"))).toBe(false);

    await writeFile(join(root, "config/other.yaml"), "disablePrivate: false\n");
    await Bun.sleep(1_050);
    expect(await live.blocked(normal)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 8_000);

test("Milky 好友上传通知可查询附件和普通回复，只在内部保留关联哈希", async () => {
  const url = "https://files.example.invalid/f";
  const { call, calls } = fixture({ download_url: url, message_seq: 17 });
  const event = milkyFriendFileUpload(upload({ message_seq: 99 }), selfId, call);
  if (!event?.file) throw new Error("缺少好友上传文件。");
  expect(event).toMatchObject({
    self_id: selfId, user_id: senderId, isMaster: false, boundAccount: false,
    message_type: "private", sub_type: "friend", msg: "", raw_message: "[file]",
  });
  expect(event.message).toEqual([event.file]);
  expect(event.file).toMatchObject({ type: "file", file: fileId, name: "记录归档.json", size: 301 });
  expect(event).not.toHaveProperty("message_id");
  expect(event).not.toHaveProperty("reply_id");
  expect(JSON.stringify(event)).not.toContain(hash);
  expect(getMilkyFileCorrelation(event.file)).toBe(hash);
  expect(getMilkyFileCorrelation({ ...event.file })).toBeUndefined();
  const ordinary = milkyMessage(envelope("friend", file({ file_hash: hash })), selfId, call);
  if (!ordinary?.file) throw new Error("缺少好友文件消息。");
  expect(getMilkyFileCorrelation(ordinary.file)).toBe(getMilkyFileCorrelation(event.file));
  expect(await event.reply("收到", true)).toBe(false);
  expect(await event.reply([{ type: "reply", id: 99 }, "收到"])).toBe(false);
  expect(calls).toEqual([]);
  const download = event.file.getDownloadUrl;
  if (typeof download !== "function") throw new Error("缺少好友文件下载能力。");
  expect(await download()).toBe(url);
  expect(await event.reply("收到")).toBe(true);
  expect(calls).toEqual([
    { action: "get_private_file_download_url", params: { user_id: senderId, file_id: fileId, file_hash: hash } },
    { action: "send_private_message", params: { user_id: senderId, message: [{ type: "text", data: { text: "收到" } }] } },
  ]);
});

test("Milky 好友上传需要登录账号、入站方向和有效附件", async () => {
  const { call, calls } = fixture({ message_seq: "17" });
  for (const event of [
    { ...upload(), self_id: selfId + 1 }, { ...upload(), event_type: "group_file_upload" },
    upload({ user_id: selfId }), upload({ user_id: 0 }), upload({ user_id: String(senderId) }),
    upload({ is_self: true }), upload({ is_self: undefined }), upload({ is_self: "false" }),
    upload({ file_name: undefined }), upload({ file_size: -1 }),
  ]) expect(milkyFriendFileUpload(event, selfId, call)).toBeUndefined();
  const event = milkyFriendFileUpload(upload({ file_hash: undefined }), selfId, call);
  if (!event?.file) throw new Error("缺少好友上传文件。");
  expect(getMilkyFileCorrelation(event.file)).toBeUndefined();
  expect(event.file).not.toHaveProperty("getDownloadUrl");
  expect(calls).toEqual([]);
  expect(await event.reply("收到")).toBe(false);
});

test("Milky 附件能力绑定单个文件，原会话查询包含好友文件哈希", async () => {
  const { calls, call } = fixture();
  const plainFile = file({ download_url: "https://example.invalid/request-cannot-set-url" });
  const privateEvent = milkyMessage(envelope("friend", plainFile), selfId, call);
  expect(privateEvent?.file).toBeDefined();
  expect(privateEvent?.attachment).toBeUndefined();
  for (const source of [
    envelope("group", plainFile, file({ file_id: "second" })),
    envelope("group", file({ file_name: "长".repeat(256) })),
    envelope("group", file({ file_size: 0 })),
    envelope("group", file({ file_size: maxChatFileBytes + 1 })),
  ]) {
    const event = milkyMessage(source, selfId, call);
    expect(event?.file).toBeDefined();
    expect(event?.attachment).toBeUndefined();
  }

  const group = milkyMessage(envelope("group", { type: "text", data: { text: "导入" } }, plainFile), selfId, call);
  const friend = milkyMessage(envelope("friend", file({ file_hash: hash })), selfId, call);
  const standalone = milkyFriendFileUpload(upload(), selfId, call);
  expect(calls).toEqual([]);
  const cancelled = AbortSignal.abort();
  for (const event of [group, friend, standalone]) {
    if (!event?.attachment) throw new Error("缺少 Milky 附件。");
    expect(event.attachment).toMatchObject({ name: "记录归档.json", size: 301 });
    expect(JSON.stringify(event.attachment)).not.toContain(hash);
    expect(await event.attachment.read(cancelled)).toBeUndefined();
  }
  expect(calls).toEqual([]);
  for (const event of [group, friend, standalone]) {
    const attachment = event!.attachment!;
    expect(await Promise.all([attachment.read(), attachment.read()])).toEqual([undefined, undefined]);
    expect(await attachment.read()).toBeUndefined();
  }
  expect(calls).toEqual([
    { action: "get_group_file_download_url", params: { group_id: groupId, file_id: fileId } },
    { action: "get_private_file_download_url", params: { user_id: senderId, file_id: fileId, file_hash: hash } },
    { action: "get_private_file_download_url", params: { user_id: senderId, file_id: fileId, file_hash: hash } },
  ]);
});

test("Milky 附件在查询期间取消时不下载，也不重复查询", async () => {
  const result = Promise.withResolvers<Record<string, unknown>>();
  const call = async () => result.promise;
  const event = milkyMessage(envelope("group", file()), selfId, call);
  if (!event?.attachment) throw new Error("缺少 Milky 附件。");
  const request = spyOn(globalThis, "fetch").mockRejectedValue(new Error("取消后不应下载。"));
  try {
    const controller = new AbortController();
    const pending = event.attachment.read(controller.signal);
    controller.abort();
    result.resolve({ download_url: "https://example.invalid/should-not-download" });
    expect(await pending).toBeUndefined();
    expect(await event.attachment.read()).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
  }
});

test("Milky 附件只下载原会话查询返回的 QQ 地址，按原长度读取一次", async () => {
  const download_url = "https://grouptalk.c2c.qq.com/fixture?key=signed";
  const { calls, call } = fixture({ download_url });
  const candidate = file({ file_size: 2, file_hash: hash, download_url: "https://example.invalid/untrusted" });
  const event = milkyMessage(envelope("friend", candidate), selfId, call);
  if (!event?.attachment) throw new Error("缺少 Milky 附件。");
  const bytes = Uint8Array.of(123, 125);
  const request = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(bytes))
    .mockResolvedValueOnce(new Response(bytes))
    .mockRejectedValue(new Error("意外重复下载。"));
  try {
    expect(await Promise.all([event.attachment.read(), event.attachment.read()])).toEqual([bytes, bytes]);
    expect(await event.attachment.read()).toEqual(bytes);
    expect(calls).toEqual([
      { action: "get_private_file_download_url", params: { user_id: senderId, file_id: fileId, file_hash: hash } },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    const source = request.mock.calls[0]?.[0];
    expect(source instanceof Request ? source.url : String(source)).toBe(download_url);
    const wrongSize = milkyMessage(envelope("friend", file({ file_size: 3, file_hash: hash })), selfId, call);
    if (!wrongSize?.attachment) throw new Error("缺少 Milky 附件。");
    expect(await wrongSize.attachment.read()).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    request.mockRestore();
  }
});
