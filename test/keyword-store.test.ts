import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createKeywordStore } from "../lib/keyword-store.ts";

async function fixture(run: (root: URL, directory: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "lotus-keywords-"));
  try {
    const directory = join(temporary, "data", "messageJson");
    await mkdir(directory, { recursive: true });
    await run(pathToFileURL(`${temporary}/`), directory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const text = (text: string) => ({ type: "text", text } as const);

test("读取旧多版本 JSON 并隔离群和全局数据，保留无法渲染的旧消息段", () => fixture(async (root, directory) => {
  const old = [[text("第一版")], [text("第二版"), { type: "forward", id: "example" }]];
  await writeFile(join(directory, "20.json"), JSON.stringify({ 词条: old }));
  await writeFile(join(directory, "global.json"), JSON.stringify({ 词条: [[text("全局")]] }));
  const store = createKeywordStore(root);
  expect(await store.read(20)).toEqual(new Map([["词条", old]]));
  expect(await store.read("global")).toEqual(new Map([["词条", [[text("全局")]]]]));
  expect(await store.read(21)).toEqual(new Map());
  await expect(store.read(-1)).rejects.toThrow("作用域无效");
}));

test("并发追加按版本原子写入，存储保留任意合法关键词和其他词条", () => fixture(async (root, directory) => {
  const file = join(directory, "20.json");
  await writeFile(file, JSON.stringify({ existing: [[{ type: "unknown", meta: { old: true } }]] }));
  const store = createKeywordStore(root);
  const another = createKeywordStore(root);
  const results = await Promise.all([
    store.append(20, "__proto__", [text("甲")]),
    another.append(20, "__proto__", [text("乙")]),
    store.append(20, "__proto__", [text("丙")]),
    another.append(20, "另一个词", [text("独立")]),
  ]);
  expect(results.slice(0, 3).sort()).toEqual([1, 2, 3]);
  expect(results[3]).toBe(1);
  const parsed = await store.read(20);
  expect(parsed.get("existing")).toEqual([[{ type: "unknown", meta: { old: true } }]]);
  expect(parsed.get("另一个词")).toEqual([[text("独立")]]);
  expect(parsed.get("__proto__")).toHaveLength(3);
  expect(parsed.get("__proto__")?.flat()).toEqual(expect.arrayContaining([text("甲"), text("乙"), text("丙")]));
  expect((await readdir(directory)).sort()).toEqual([".lotus-keywords.sqlite", "20.json"]);
  expect(await store.append(21, "新文件", [text("内容")])).toBe(1);
  expect(await another.read(21)).toEqual(new Map([["新文件", [[text("内容")]]]]));
}));

test("按 1 起的版本号删除，缺少版本号删除整条，关联旧媒体不被删除", () => fixture(async (root, directory) => {
  const store = createKeywordStore(root);
  const media = join(directory, "20/image/shared.png");
  await mkdir(join(directory, "20/image"), { recursive: true });
  await writeFile(media, new Uint8Array([1, 2, 3]));
  const image = { type: "image", file: "20/image/shared.png" };
  await store.append(20, "甲", [image]);
  await store.append(20, "甲", [text("另一版")]);
  await store.append(20, "乙", [image]);
  expect(await store.remove(20, "甲", 0)).toBe(false);
  expect(await store.remove(20, "甲", 3)).toBe(false);
  expect(await store.remove(20, "甲", 1)).toBe(true);
  expect((await store.read(20)).get("甲")).toEqual([[text("另一版")]]);
  expect(await store.remove(20, "甲")).toBe(true);
  expect(await store.remove(20, "甲")).toBe(false);
  expect(await store.read(20)).toEqual(new Map([["乙", [[image]]]]));
  expect([...await readFile(media)]).toEqual([1, 2, 3]);
  expect(await store.remove(20, "乙", 1)).toBe(true);
  expect(await store.read(20)).toEqual(new Map());
}));

test("格式不合旧结构的 JSON 和符号链接均不会被覆盖", () => fixture(async (root, directory) => {
  const store = createKeywordStore(root);
  const file = join(directory, "20.json");
  for (const bytes of ['{"坏":', '{"坏": [{"type":"text","text":"内容"}]}', '{"坏": [[{}]]}']) {
    await writeFile(file, bytes);
    await expect(store.read(20)).rejects.toThrow("JSON 格式无效");
    await expect(store.append(20, "新", [text("值")])).rejects.toThrow("JSON 格式无效");
    await expect(store.remove(20, "坏")).rejects.toThrow("JSON 格式无效");
    expect(await readFile(file, "utf8")).toBe(bytes);
  }
  await expect(store.append(21, " ", [text("值")])).rejects.toThrow("内容无效");
  await expect(store.append(21, "词条", [])).rejects.toThrow("内容无效");
  await symlink("20.json", join(directory, "21.json"));
  await expect(store.append(21, "新", [text("值")])).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe('{"坏": [[{}]]}');
}));

test("渲染只转换支持的宿主段，读取旧目录媒体或保留 HTTPS 和合法 base64", () => fixture(async (root, directory) => {
  const store = createKeywordStore(root);
  await mkdir(join(directory, "20", "image"), { recursive: true });
  await writeFile(join(directory, "20", "image", "a.png"), new Uint8Array([1, 2, 3]));
  await symlink("a.png", join(directory, "20/image/inside.png"));
  const parts = await store.render([
    text("你好"), { type: "at", qq: "42" }, { type: "at", qq: "all" }, { type: "face", data: { id: 0 } },
    { type: "image", file: "20/image/inside.png" }, { type: "record", file: "base64://AQI=" },
    { type: "video", file: "opaque-id", url: "https://media.example.invalid/video.webm" },
    { type: "forward", id: "opaque" }, { type: "reply", id: 5 },
  ]);
  expect(parts).toEqual([
    text("你好"), { type: "at", qq: "42" }, { type: "at", qq: "all" }, { type: "face", id: 0 },
    { type: "image", file: Buffer.from([1, 2, 3]) }, { type: "record", file: "base64://AQI=" },
    { type: "video", file: "https://media.example.invalid/video.webm" },
  ]);
}));

test("否决绝对路径、向外遍历、文件和父目录链接逃逸、非 HTTPS 或损坏的媒体引用", () => fixture(async (root, directory) => {
  const store = createKeywordStore(root);
  const outside = `${directory}2`;
  await mkdir(outside);
  await mkdir(join(directory, "20/image"), { recursive: true });
  const secret = join(outside, "secret.png");
  await writeFile(secret, "中文内容");
  await symlink(secret, join(directory, "20/image/escape.png"));
  await symlink(outside, join(directory, "20/image/outside"));
  await writeFile(join(directory, "20.json"), "{}");
  await symlink("../../20.json", join(directory, "20/image/disguised.png"));
  expect(await store.render([
    ...[secret, "../messageJson2/secret.png", "20/image/escape.png", "20/image/outside/secret.png", "C:\\secret.png", "file:///secret.png",
      "http://media.example.invalid/a.png", "https://user:password@media.example.invalid/a.png", "base64://x===",
      "https:// media.example.invalid/invalid", "20/image/missing.png", "20.json", "20/image/disguised.png"].map((file) => ({ type: "image", file })),
    { type: "video", file: "20/image/disguised.png" },
    { type: "at", qq: "invalid" }, { type: "face", id: -1 }, { type: "audio", file: "base64://AQI=" },
  ])).toBeUndefined();
  expect(await readFile(secret, "utf8")).toBe("中文内容");
}));
