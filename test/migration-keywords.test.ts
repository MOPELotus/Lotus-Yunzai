import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { maxChatFileBytes } from "../lib/chat-files.ts";
import { createKeywordStore } from "../lib/keyword-store.ts";
import { createKeywords } from "../lib/keywords.ts";
import type { MessageReply } from "../lib/messages.ts";
import { stageLegacyKeywords } from "../lib/migration-keywords.ts";

const store = "data/messageJson";
const backup = "backup/legacy-keywords";

async function fixture(run: (source: string, state: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-keyword-migration-"));
  try {
    const source = join(root, "source"), state = join(root, "state");
    await Promise.all([mkdir(source, { mode: 0o700 }), mkdir(state, { mode: 0o700 })]);
    await run(source, state);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function save(root: string, path: string, bytes: string | Buffer) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
  return file;
}

function runner(root: string) {
  const keywords = createKeywords(createKeywordStore(pathToFileURL(root + sep)), () => ({
    addLimit: 0, addPrivate: true, addReply: false, addAt: false, addRecall: 0,
  }), undefined, undefined, async () => { throw Error("Migration and keyword replay must not fetch media."); });
  return async (msg: string, group = 77) => {
    const replies: MessageReply[] = [];
    const handled = await keywords.dispatch({
      msg, raw_message: msg, message: msg, post_type: "message", message_type: "group",
      self_id: 99, user_id: 42, group_id: group, isGroup: true, isPrivate: false, boundAccount: true, isMaster: false,
      reply(message) { replies.push(message); return true; },
    });
    return { handled, reply: replies[0] };
  };
}

test("the active TRSS books preserve order, global and group scope, supported media and current list and replay", async () => fixture(async (source, state) => {
  const photo = Buffer.from([1, 2, 3]);
  const audio = Buffer.from([4, 5, 6]);
  const video = Buffer.from([7, 8, 9]);
  const group = JSON.stringify({ 早安: [[{ type: "text", text: "群内一" },
    { type: "image", file: "global/image/原图.png" }, { type: "record", data: { file: "77/record/声音.silk" } },
    { type: "video", file: "77/video/nested/视频.mp4" }], [{ type: "text", text: "群内二" }]],
  网址: [[{ type: "image", url: "https://cdn.example.invalid/illustration.png" }]] }, null, 2);
  const global = JSON.stringify({ 早安: [[{ type: "text", text: "全局一" }]], 全局词: [[{ type: "text", text: "公共" }]] });
  await save(source, `${store}/77.json`, group);
  await save(source, `${store}/global.json`, global);
  await save(source, `${store}/global/image/原图.png`, photo);
  await save(source, `${store}/77/record/声音.silk`, audio);
  await save(source, `${store}/77/video/nested/视频.mp4`, video);
  await save(source, `${store}/global/目录表情.png`, "legacy list-only file");
  await save(source, `${store}/77/image/unreferenced.png`, "unreferenced");
  await save(source, "data/textJson/global.json", '{"旧表情":[[{"type":"text","text":"休眠库"}]]}');
  const report = await stageLegacyKeywords(source, state);
  expect(report).toMatchObject({ scopes: 2, keywords: 4, media: 3, archived: 4, unresolvedMedia: 0 });
  expect(await readFile(join(state, store, "77.json"), "utf8")).toBe(group);
  expect(await readFile(join(state, backup, "global.json"), "utf8")).toBe(global);
  expect(await readFile(join(state, backup, "77/image/unreferenced.png"), "utf8")).toBe("unreferenced");
  expect(await readFile(join(state, backup, "global/目录表情.png"), "utf8")).toBe("legacy list-only file");
  expect(await stat(join(state, store, "77/video/nested/视频.mp4")).then(info => info.mode & 0o777)).toBe(0o600);
  await expect(stat(join(state, "data/textJson"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(state, store, "global/目录表情.png"))).rejects.toMatchObject({ code: "ENOENT" });

  const send = runner(state);
  expect((await send("#词条列表")).reply).toContain("早安(2)");
  expect((await send("#全局词条列表")).reply).toContain("全局词(1)");
  expect((await send("早安1")).reply).toEqual([
    { type: "text", text: "群内一" }, { type: "image", file: photo }, { type: "record", file: audio }, { type: "video", file: video },
  ]);
  expect((await send("早安3")).reply).toEqual([{ type: "text", text: "全局一" }]);
  expect((await send("早安1", 78)).reply).toEqual([{ type: "text", text: "全局一" }]);
  expect((await send("网址")).reply).toEqual([{ type: "image", file: "https://cdn.example.invalid/illustration.png" }]);
  expect((await send("旧表情")).handled).toBe(false);
}));

test("active legacy flat records normalize without enabling unsafe or oversized attachments", () => fixture(async (source, state) => {
  const untrusted = await save(source, "elsewhere/private", "do not migrate");
  await mkdir(join(source, store, "77/image"), { recursive: true, mode: 0o700 });
  await symlink(untrusted, join(source, store, "77/image/linked.png"));
  const big = await save(source, `${store}/77/video/big.mp4`, "");
  await truncate(big, maxChatFileBytes + 1);
  const huge = await save(source, `${store}/unknown.bin`, "");
  await truncate(huge, 64 * 1024 * 1024 + 1);
  const old = JSON.stringify({ 扁平: [{ type: "text", text: "旧形态" }], 坏词条: "unexpected", 媒体: [[
    { type: "text", text: "保留文字" }, { type: "image", file: "77/image/linked.png" },
    { type: "image", file: "77/image/../../outside" }, { type: "video", file: "77/video/big.mp4" },
  ]] });
  await save(source, `${store}/77.json`, old);
  await save(source, `${store}/78.json`, "broken syntax");
  await save(source, `${store}/090.json`, "unroutable record");
  const report = await stageLegacyKeywords(source, state);
  expect(report).toEqual({ scopes: 1, keywords: 2, media: 0, archived: 4, unresolvedMedia: 3,
    normalizedKeywords: 1, rejectedScopes: 1, rejectedKeywords: 1, skippedFiles: 2 });
  expect(await readFile(join(state, backup, "77.json"), "utf8")).toBe(old);
  expect(await readFile(join(state, backup, "78.json"), "utf8")).toBe("broken syntax");
  expect((await stat(join(state, backup, "77/video/big.mp4"))).size).toBe(maxChatFileBytes + 1);
  await expect(stat(join(state, store, "77/video/big.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(state, store, "78.json"))).rejects.toMatchObject({ code: "ENOENT" });
  const send = runner(state);
  expect((await send("扁平1")).reply).toEqual([{ type: "text", text: "旧形态" }]);
  expect((await send("媒体")).reply).toEqual([{ type: "text", text: "保留文字" }]);
  expect((await send("坏词条")).handled).toBe(false);
}));

test("dormant data remains untouched and linked active JSON is rejected without opening its target", () => fixture(async (source, state) => {
  const old = await save(source, "data/textJson/global.json", '{"旧":[[{"type":"text","text":"休眠"}]]}');
  expect(await stageLegacyKeywords(source, state)).toMatchObject({ scopes: 0, archived: 0, media: 0 });
  await expect(stat(join(state, "data"))).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(join(source, store), { recursive: true, mode: 0o700 });
  const alias = join(source, store, "global.json");
  await symlink(old, alias);
  await expect(stageLegacyKeywords(source, state)).rejects.toThrow("无硬链接的普通 JSON");
  await rm(alias);
  await link(old, alias);
  await expect(stageLegacyKeywords(source, state)).rejects.toThrow("无硬链接的普通 JSON");
  await expect(stat(join(state, "data"))).rejects.toMatchObject({ code: "ENOENT" });
}));
