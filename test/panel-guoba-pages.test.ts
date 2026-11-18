import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGuobaPages } from "../lib/panel-guoba-pages.ts";

async function directory(root: string, plugin: string, name: string = "guoba") {
  const path = join(root, plugin, name);
  await mkdir(path, { recursive: true });
  return path;
}

async function manifest(path: string, value: unknown, filename: string = "page.json") {
  await writeFile(join(path, filename), JSON.stringify(value));
}

test("锅巴 Next 静态描述符沿用目录、文件、排序和重复 ID 规则", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-guoba-pages-"));
  try {
    const first = await directory(root, "first");
    const shadowed = await directory(root, "first", "webadapter");
    const compatibility = await directory(root, "compatibility", "webadapter");
    const empty = await directory(root, "empty");
    const hiddenFallback = await directory(root, "empty", "webadapter");
    const minimal = await directory(root, "minimal");
    await mkdir(join(first, "files"));
    await writeFile(join(first, "files", "dash.html"), "<h3>扩展页面</h3>");
    await writeFile(join(first, "files", "style.css"), "h3 { color: green; }");
    await writeFile(join(first, "files", "script.js"), "document.title = '扩展';");
    await manifest(first, { pages: [
      { id: "hello", title: "你好页", icon: "👋", html: "<h3>你好，这是自定义页面</h3>" },
      { id: "dashboard", title: "仪表盘", usePluginIcon: true, priority: 20, html: "被静态 HTML 文件替代",
        src: "files/dash.html", style: "files/style.css", script: "files/script.js" },
    ] }, "pages.json");
    await writeFile(join(first, "page.js"), 'throw new Error("未采用的 JS");');
    await manifest(first, { id: "low-priority", title: "低优先级文件", html: "ignored" });
    await manifest(shadowed, { id: "shadowed", title: "备用目录", html: "ignored" });
    await manifest(compatibility, [
      { id: "hello", title: "后续重复页", priority: 1, html: "duplicate" },
      { id: "other", title: "兼容目录", priority: 20, html: "兼容" },
    ], "pages.json");
    await manifest(hiddenFallback, { id: "hidden", title: "存在空 guoba 时不扫描备用目录", html: "ignored" });
    await manifest(minimal, { id: "minimal", title: "单对象", priority: -1, html: "静态" });

    const pages = await loadGuobaPages(new Map([
      ["first", join(first, "..")],
      ["compatibility", join(compatibility, "..")],
      ["empty", join(empty, "..")],
      ["minimal", join(minimal, "..")],
    ]));
    expect(pages.pages.map(({ id }) => id)).toEqual(["minimal", "dashboard", "other", "hello"]);
    expect(pages.pages.find(({ id }) => id === "hello")).toMatchObject({
      plugin: "first", title: "你好页", icon: "👋", html: "<h3>你好，这是自定义页面</h3>", priority: 100,
    });
    expect(pages.pages.find(({ id }) => id === "dashboard")).toMatchObject({
      usePluginIcon: true, src: "files/dash.html", style: "files/style.css", script: "files/script.js",
    });
    expect(pages.pages.find(({ id }) => id === "dashboard")?.html).toBeUndefined();
    expect(pages.issues).toEqual([{ plugin: "compatibility", descriptor: "pages.json", id: "hello", kind: "duplicate-id" }]);
    const entry = await pages.resolveAsset("dashboard", "files/dash.html");
    expect(entry?.isEntry).toBe(true);
    expect(entry && await readFile(entry.path, "utf8")).toBe("<h3>扩展页面</h3>");
    expect(await pages.resolveAsset("dashboard", "files/style.css")).toMatchObject({ isEntry: false });
    expect(await pages.resolveAsset("dashboard", "files/script.js")).toMatchObject({ isEntry: false });
    expect(await pages.resolveAsset("dashboard", "pages.json")).toBeUndefined();
    expect(await pages.resolveAsset("dashboard", "files/./dash.html")).toBeUndefined();
    expect(await pages.resolveAsset("hello", "files/dash.html")).toBeUndefined();
    expect(JSON.stringify(pages.pages)).not.toContain(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("优先 JS 只标为暂不支持，并拒绝越界描述符和资源", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-guoba-pages-boundary-"));
  try {
    const script = await directory(root, "script");
    const descriptorLink = await directory(root, "descriptor-link");
    const escapedDirectory = join(root, "escaped-directory");
    const resources = await directory(root, "resources");
    const outside = await directory(root, "not-loaded");
    const marker = join(script, "executed");
    await mkdir(escapedDirectory);
    await writeFile(join(script, "index.js"), `await Bun.write(${JSON.stringify(marker)}, "bad");`);
    await manifest(script, { id: "ignored", title: "不可回退", html: "ignored" }, "pages.json");
    await manifest(outside, { id: "secret", title: "fixture-private", html: "fixture-private" });
    await writeFile(join(outside, "outside.html"), "fixture-private-content");
    await manifest(descriptorLink, { id: "ignored-json", title: "不可回退", html: "ignored" });
    await symlink(join(outside, "page.json"), join(descriptorLink, "pages.json"));
    await symlink(outside, join(escapedDirectory, "guoba"));
    await writeFile(join(resources, "inside.html"), "<p>合法扩展页</p>");
    await symlink(join(outside, "outside.html"), join(resources, "outside-link.html"));
    await manifest(resources, [
      { id: "inline", title: "正常片段", html: "<h3>你好</h3>" },
      { id: "nested", title: "正常文件", src: "inside.html" },
      { id: "link", title: "越界链接", src: "outside-link.html" },
      { id: "dotdot", title: "越界路径", style: "../outside.css", html: "blocked" },
      { id: "absolute", title: "绝对路径", src: join(outside, "outside.html"), html: "blocked" },
      { id: "suffix", title: "禁止文件", html: "blocked", script: "config.toml" },
      { id: "manage", title: "保留页", html: "blocked" },
      { id: "missing", title: "资源不存在", src: "missing.html" },
    ], "pages.json");

    const pages = await loadGuobaPages(new Map([
      ["script", join(script, "..")],
      ["descriptor-link", join(descriptorLink, "..")],
      ["escaped-directory", escapedDirectory],
      ["resources", join(resources, "..")],
    ]));
    expect(pages.pages.map(({ id }) => id)).toEqual(["inline", "nested"]);
    expect(pages.issues).toEqual([
      { plugin: "script", descriptor: "index.js", kind: "unsupported-js" },
      { plugin: "descriptor-link", descriptor: "pages.json", kind: "invalid" },
      { plugin: "escaped-directory", descriptor: undefined, kind: "invalid" },
      ...Array.from({ length: 6 }, () => ({ plugin: "resources", descriptor: "pages.json", kind: "invalid" } as const)),
    ]);
    expect(JSON.stringify(pages.issues)).not.toContain(root);
    expect(JSON.stringify(pages.pages)).not.toContain("fixture-private");
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await pages.resolveAsset("nested", "inside.html")).toMatchObject({ isEntry: true });

    await rm(join(resources, "inside.html"));
    await symlink(join(outside, "outside.html"), join(resources, "inside.html"));
    expect(await pages.resolveAsset("nested", "inside.html")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
