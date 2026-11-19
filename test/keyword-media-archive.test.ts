import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeMilkyReply } from "../lib/adapters/milky-message.ts";
import { encodeOneBotReply } from "../lib/adapters/onebot-message.ts";
import { maxChatFileBytes } from "../lib/chat-files.ts";
import { delegationSession } from "../lib/command-delegation.ts";
import { createKeywordStore } from "../lib/keyword-store.ts";
import { createKeywords } from "../lib/keywords.ts";
import type { InboundSegment, MessageEvent, MessageReply } from "../lib/messages.ts";

type ReadMedia = NonNullable<Parameters<typeof createKeywords>[4]>;
const imageUrl = "https://gchat.qpic.cn/gchatpic_new/fixture-image?token=fake";
const recordUrl = "https://multimedia.nt.qq.com.cn/download?token=fake-voice";
const freshRecordUrl = "https://multimedia.nt.qq.com.cn/download?token=new-fake-voice";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const text = (text: string) => ({ type: "text", text } as const);

async function fixture(run: (root: URL, data: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-keyword-media-"));
  try {
    const data = join(directory, "data", "messageJson");
    await mkdir(data, { recursive: true });
    await run(pathToFileURL(`${directory}/`), data);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function commands(root: URL, readMedia: ReadMedia) {
  const store = createKeywordStore(root);
  const controller = new AbortController();
  const resolveSettings = () => ({ addLimit: 0 as const, addPrivate: true, addReply: false, addAt: false, addRecall: 0 });
  const keywords = createKeywords(store, resolveSettings, undefined, undefined, readMedia);
  const session = {
    signal: controller.signal,
    groups: async () => [], members: async () => [], isFriend: async () => false,
    botMute: async () => undefined, memberRole: async () => undefined, send: async () => "rejected" as const,
  };
  const replies: MessageReply[] = [];
  function event(msg: string, message: MessageEvent["message"] = msg): MessageEvent {
    return {
      msg, raw_message: msg, message, post_type: "message", message_type: "group", self_id: 99, user_id: 51,
      group_id: 77, isGroup: true, isPrivate: false, isMaster: false, boundAccount: true, [delegationSession]: session,
      reply: value => { replies.push(value); return true; },
    };
  }
  return { store, keywords, event, controller, replies };
}

test("排队中的图片完成归档才保存，三种媒体按原顺序在失效后回放", () => fixture(async (root, data) => {
  const image = Buffer.from([1, 2, 3]);
  const record = Buffer.from([4, 5]);
  const video = Buffer.from([6, 7, 8]);
  const imageStarted = Promise.withResolvers<void>();
  const imageReady = Promise.withResolvers<Uint8Array>();
  const requests: unknown[] = [];
  let expired = false;
  let renewed = 0;
  const { store, keywords, event, replies } = commands(root, async url => {
    requests.push(url);
    if (expired) return;
    if (url === imageUrl) {
      imageStarted.resolve();
      return imageReady.promise;
    }
    if (url === freshRecordUrl) return record;
  });
  const initial = JSON.stringify({ 旧词: [[text("旧内容")]] });
  const file = join(data, "77.json");
  await writeFile(file, initial);
  await keywords.dispatch(event("#添加媒体"));
  await keywords.continue(event("开头", [text("开头"), { type: "image", url: imageUrl }]));
  await imageStarted.promise;
  await keywords.continue(event("中间", [
    text("中间"), { type: "record", url: recordUrl, getDownloadUrl: async () => { renewed++; return freshRecordUrl; } },
    { type: "video", file: "base64://BgcI" }, text("结尾"),
  ]));
  const finish = keywords.continue(event("#结束添加"));
  expect(await readFile(file, "utf8")).toBe(initial);
  expect(replies).toHaveLength(1);
  imageReady.resolve(image);
  expect(await finish).toBe(true);
  expect(replies.at(-1)).toBe("添加成功：媒体");
  expect(renewed).toBe(1);
  expect(requests).toEqual([imageUrl, recordUrl, freshRecordUrl]);

  const paths = ([["image", image], ["record", record], ["video", video]] as const)
    .map(([type, bytes]) => `77/${type}/${hash(bytes)}`);
  const saved = JSON.parse(await readFile(file, "utf8"));
  expect(saved).toEqual({ 旧词: [[text("旧内容")]], 媒体: [[
    text("开头"), { type: "image", file: paths[0] }, text("中间"), { type: "record", file: paths[1] },
    { type: "video", file: paths[2] }, text("结尾"),
  ]] });
  for (const [index, bytes] of [image, record, video].entries()) expect(await readFile(join(data, paths[index]!))).toEqual(bytes);

  expired = true;
  const reloaded = createKeywordStore(root);
  const parts = (await reloaded.read(77)).get("媒体")?.[0];
  const reply = await reloaded.render(parts!);
  expect(reply).toEqual([text("开头"), { type: "image", file: image }, text("中间"), { type: "record", file: record },
    { type: "video", file: video }, text("结尾")]);
  const onebot = encodeOneBotReply(reply);
  expect(Array.isArray(onebot) && onebot.flatMap(part => part.data.file ?? [])).toEqual(["base64://AQID", "base64://BAU=", "base64://BgcI"]);
  expect(encodeMilkyReply(reply!)?.flatMap(part => "uri" in part.data ? [part.data.uri] : [])).toEqual(["base64://AQID", "base64://BAU=", "base64://BgcI"]);
  expect(requests).toHaveLength(3);
  expect(await store.read(77)).toEqual(await reloaded.read(77));
}));

test("报告损坏和超限媒体，保存其他片段且不会持久化来源 URL", () => fixture(async (root, data) => {
  const limit = Buffer.alloc(maxChatFileBytes, 1);
  const { store, keywords, event, replies } = commands(root, async url => url === imageUrl ? limit : undefined);
  await keywords.dispatch(event("#添加有内容"));
  await keywords.continue(event("文字", [text("文字"), { type: "image", url: imageUrl },
    { type: "video", url: "https://example.invalid/rejected" }, { type: "record", file: "base64://AA==" }]));
  await keywords.continue(event("#结束添加"));
  expect(replies.at(-1)).toBe("添加成功：有内容。有 2 个媒体下载失败或超过限额，请重新发送。");
  expect((await store.read(77)).get("有内容")).toEqual([[text("文字"), { type: "image", file: `77/image/${hash(limit)}` }]]);
  expect(await readFile(join(data, "77.json"), "utf8")).not.toContain("https://");
  await keywords.dispatch(event("#添加损坏内联"));
  await keywords.continue(event("", [{ type: "record", file: "base64://AR==" }]));
  await keywords.continue(event("#结束添加"));
  expect(replies.at(-1)).toContain("有 1 个媒体下载失败");
  expect((await store.read(77)).has("损坏内联")).toBe(false);
  await expect(store.append(77, "超限单个", [{ type: "image", file: Buffer.alloc(maxChatFileBytes + 1) }])).rejects.toThrow("16 MiB");
  await expect(store.append(77, "超限整条", [{ type: "image", file: limit }, { type: "record", file: Buffer.from([0]) }])).rejects.toThrow("16 MiB");
}));

test("连接在收录等待中关闭时不会提交媒体或词条", () => fixture(async (root, data) => {
  const started = Promise.withResolvers<void>();
  const { store, keywords, event, controller, replies } = commands(root, async (_url, signal) => {
    started.resolve();
    await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
    return Buffer.from([1, 2, 3]);
  });
  await keywords.dispatch(event("#添加未完成"));
  await keywords.continue(event("", [{ type: "image", url: imageUrl }]));
  await started.promise;
  const finish = keywords.continue(event("#结束添加"));
  controller.abort();
  expect(await finish).toBe(true);
  expect(await store.read(77)).toEqual(new Map());
  expect(await readdir(data)).toEqual([]);
  expect(replies).toHaveLength(1);
}));

test("归档冲突不改旧词条或已存在文件，并回滚未引用文件", () => fixture(async (root, data) => {
  const store = createKeywordStore(root);
  const bytes = Buffer.from([1, 2, 3]);
  const original = JSON.stringify({ 旧词: [[text("旧内容")]] });
  const file = join(data, "global.json");
  const room = join(data, "global", "record");
  const blocked = join(room, hash(bytes));
  await mkdir(room, { recursive: true });
  await writeFile(file, original);
  await writeFile(blocked, Buffer.from([9, 9, 9]));
  const parts = [{ type: "image", file: bytes }, { type: "record", file: bytes }] as const satisfies readonly InboundSegment[];
  await expect(store.append("global", "失败", parts)).rejects.toThrow("归档内容不一致");
  expect(await readFile(file, "utf8")).toBe(original);
  expect(await readFile(blocked)).toEqual(Buffer.from([9, 9, 9]));
  expect(await readdir(join(data, "global", "image"))).toEqual([]);

  await mkdir(join(data, "elsewhere"));
  await symlink("elsewhere", join(data, "78"));
  await expect(store.append(78, "失败", parts)).rejects.toThrow("媒体目录无效");
  expect(await readdir(join(data, "elsewhere"))).toEqual([]);
  expect(await store.read(78)).toEqual(new Map());

  await store.append("global", "第一条", [parts[0]]);
  await store.append("global", "第二条", [parts[0]]);
  expect(await readdir(join(data, "global", "image"))).toEqual([hash(bytes)]);
  expect(await store.remove("global", "第一条")).toBe(true);
  expect(await store.render((await store.read("global")).get("第二条")![0]!)).toEqual([parts[0]]);
}));
