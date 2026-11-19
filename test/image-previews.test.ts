import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeMilkyReply } from "../lib/adapters/milky-message.ts";
import { encodeOneBotForward, encodeOneBotReply } from "../lib/adapters/onebot-message.ts";
import { loadImagePreviews, prepareImagePreviewRelease, startImagePreviews } from "../lib/image-previews.ts";
import { segment, setImagePreviews } from "../lib/messages.ts";

test("出站图片预览沿用旧缓存，二种适配器发送同一份摘要并保留显式值", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-image-preview-"));
  const root = pathToFileURL(`${directory}/`);
  const file = "https://example.invalid/card.png";
  try {
    expect(await loadImagePreviews(root)).toEqual([]);
    expect(segment.image(file)).toEqual({ type: "image", file });
    const old = new URL("temp/Lotus-Plugin/poetry/", root);
    await mkdir(old, { recursive: true });
    await writeFile(new URL("lines.json", old), JSON.stringify({ lines: ["  旧版摘要  ", null] }));
    setImagePreviews(await loadImagePreviews(root));
    const expected = "旧版摘要";
    const image = segment.image(file);
    const onebotImage = [{ type: "image", data: { file, summary: expected } }];
    expect(encodeOneBotReply(image)).toEqual(onebotImage);
    expect(encodeOneBotForward([image], 99)?.[0]?.data.content).toEqual(onebotImage);
    expect(encodeMilkyReply(image)).toEqual([{ type: "image", data: { uri: file, sub_type: "normal", summary: expected } }]);
    expect(encodeOneBotReply(segment.image(file, "业务摘要"))).toMatchObject([{ data: { summary: "业务摘要" } }]);
    expect(encodeMilkyReply({ type: "image", data: { file, summary: "业务摘要" } })).toMatchObject([{ data: { summary: "业务摘要" } }]);
    await rm(old, { recursive: true });
    expect(await loadImagePreviews(root)).toEqual([expected]);
  } finally {
    setImagePreviews([]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("从旧单库存档只读恢复摘要，保留旧格式和源码数据", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-image-preview-db-"));
  const root = pathToFileURL(`${directory}/`);
  const old = join(directory, "temp/Lotus-Plugin/poetry");
  const path = join(old, "poetry.db");
  try {
    await mkdir(old, { recursive: true });
    const db = new Database(path);
    try {
      db.exec(`CREATE TABLE poems_zh_hans (title TEXT, content TEXT, author_id INTEGER, dynasty_id INTEGER);
        CREATE TABLE authors_zh_hans (id INTEGER, name TEXT);
        CREATE TABLE dynasties_zh_hans (id INTEGER, name TEXT);
        INSERT INTO authors_zh_hans VALUES (1, '作者');
        INSERT INTO dynasties_zh_hans VALUES (2, '朝代');`);
      db.run("INSERT INTO poems_zh_hans VALUES (?, ?, 1, 2)", ["题目", '["<b>甲句</b>。乙句！", "丙句"]']);
    } finally {
      db.close();
    }
    const source = await readFile(path);
    expect(await loadImagePreviews(root)).toEqual(["甲句。 —— [朝代] 作者 《题目》", "乙句！ —— [朝代] 作者 《题目》", "丙句 —— [朝代] 作者 《题目》"]);
    expect(await readFile(path)).toEqual(source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("首次取得的资源需验 HTTPS 来源、大小和摘要，原子保存后可离线启动", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-image-preview-release-"));
  const root = pathToFileURL(`${directory}/`);
  try {
    const source = join(directory, "fixture.sqlite");
    const db = new Database(source);
    try {
      db.exec(`CREATE TABLE poems_zh_hans (title TEXT, content TEXT, author_id INTEGER, dynasty_id INTEGER);
        CREATE TABLE authors_zh_hans (id INTEGER, name TEXT);
        CREATE TABLE dynasties_zh_hans (id INTEGER, name TEXT);
        INSERT INTO poems_zh_hans VALUES ('', '原始资料', null, null);`);
    } finally {
      db.close();
    }
    const bytes = await readFile(source);
    const archive = Bun.gzipSync(bytes);
    const asset = {
      url: "https://github.com/fixture/release",
      compressedBytes: archive.byteLength,
      unpackedLimit: bytes.byteLength,
      sha256: createHash("sha256").update(archive).digest("hex"),
    };
    const controller = new AbortController();
    const received: string[] = [];
    const request = (async (input: URL, init: RequestInit) => {
      expect(init.redirect).toBe("manual");
      received.push(input.hostname);
      return input.hostname === "github.com"
        ? Response.redirect("https://release-assets.githubusercontent.com/source", 302)
        : new Response(archive);
    }) as typeof fetch;
    expect(await prepareImagePreviewRelease(root, controller.signal, request, { ...asset, sha256: "0".repeat(64) })).toEqual([]);
    expect(await prepareImagePreviewRelease(root, controller.signal, request, { ...asset, unpackedLimit: 128 })).toEqual([]);
    expect(await prepareImagePreviewRelease(root, controller.signal, request, { ...asset, url: "https://example.invalid/file" })).toEqual([]);
    expect(await loadImagePreviews(root)).toEqual([]);
    expect(await readdir(join(directory, "data/image-previews"))).toEqual([".release.sqlite"]);
    expect(await prepareImagePreviewRelease(root, controller.signal, request, asset)).toEqual(["原始资料"]);
    expect(received).toEqual(Array.from({ length: 3 }, () => ["github.com", "release-assets.githubusercontent.com"]).flat());
    controller.abort();
    expect(await prepareImagePreviewRelease(root, controller.signal, request, asset)).toEqual([]);
    const published: (readonly string[])[] = [];
    await startImagePreviews(root, new AbortController().signal, lines => published.push(lines));
    expect(published).toEqual([["原始资料"]]);
    expect((await readdir(join(directory, "data/image-previews"))).sort()).toEqual([".release.sqlite", "release-lines.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
