import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { milkyMessage } from "../lib/adapters/milky-message.ts";
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
