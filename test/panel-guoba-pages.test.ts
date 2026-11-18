import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchGuobaApi } from "../lib/panel-guoba-http.ts";
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

test("首选描述符加载失败时不回退，并拒绝越界的 JS、JSON 和资源", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-guoba-pages-boundary-"));
  try {
    const script = await directory(root, "script");
    const scriptLink = await directory(root, "script-link");
    const descriptorLink = await directory(root, "descriptor-link");
    const escapedDirectory = join(root, "escaped-directory");
    const resources = await directory(root, "resources");
    const outside = await directory(root, "not-loaded");
    const marker = join(outside, "executed");
    await mkdir(escapedDirectory);
    await writeFile(join(script, "index.js"), 'throw new Error("fixture-private-import");');
    await manifest(script, { id: "ignored", title: "不可回退", html: "ignored" }, "pages.json");
    await writeFile(join(outside, "outside.js"), `await Bun.write(${JSON.stringify(marker)}, "bad");`);
    await symlink(join(outside, "outside.js"), join(scriptLink, "index.js"));
    await manifest(scriptLink, { id: "ignored-link", title: "不可回退", html: "ignored" });
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
      ["script-link", join(scriptLink, "..")],
      ["descriptor-link", join(descriptorLink, "..")],
      ["escaped-directory", escapedDirectory],
      ["resources", join(resources, "..")],
    ]));
    expect(pages.pages.map(({ id }) => id)).toEqual(["inline", "nested"]);
    expect(pages.issues).toEqual([
      { plugin: "script", descriptor: "index.js", kind: "invalid" },
      { plugin: "script-link", descriptor: "index.js", kind: "invalid" },
      { plugin: "descriptor-link", descriptor: "pages.json", kind: "invalid" },
      { plugin: "escaped-directory", descriptor: undefined, kind: "invalid" },
      ...Array.from({ length: 6 }, () => ({ plugin: "resources", descriptor: "pages.json", kind: "invalid" } as const)),
    ]);
    expect(JSON.stringify(pages.issues)).not.toContain(root);
    expect(JSON.stringify(pages.issues)).not.toContain("fixture-private");
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

test("锅巴 Next JavaScript 描述符支持异步 init、批量登记和 API 兼容上下文", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-guoba-pages-dynamic-"));
  try {
    const dynamic = await directory(root, "some plugin", "webadapter");
    const named = await directory(root, "named");
    const preferred = await directory(root, "preferred");
    const notLoaded = await directory(root, "not-loaded");
    await writeFile(join(dynamic, "dash.html"), "<h3>动态页面</h3>");
    await writeFile(join(dynamic, "index.js"), `
      export default { id: "ignored-default", title: "不得读取默认导出", html: "ignored" };
      export async function init(ctx) {
        await Promise.resolve();
        if (ctx.pluginName !== "some plugin" || ctx.basePath !== "/guoba"
            || ctx.apiBase !== "/guoba/api/custom/some%20plugin" || !ctx.pluginDir.endsWith("/webadapter")
            || typeof ctx.logger.mark !== "function") throw new Error("上下文错误");
        const page = { id: "dash", title: "动态页面", src: "dash.html", priority: 21 };
        ctx.registerPage(page);
        page.id = "must-not-change";
        ctx.registerPages({ pages: [
          { id: "batch", title: "批量页面", html: "<p>批量</p>", priority: 20 },
          { id: "dash", title: "重复页面", html: "<p>不覆盖</p>" }
        ] });
        ctx.registerApi("GET", "/rules/:file/", function middleware(req, _res, next) {
          req.fixture = "middleware";
          return next();
        }, async function handler(req, res) {
          await Promise.resolve();
          ctx.registerPage({ id: "late", title: "初始化后", html: "ignored" });
          ctx.registerApi("get", "/late", () => "ignored");
          return res.json({ fixture: req.fixture, file: req.params.file });
        });
        ctx.registerApi("get", "/rules/:file", () => "duplicate");
        ctx.registerApi(undefined, "/", () => "empty route");
        ctx.registerApi("PATCH", "/rules/:file", () => "patched");
      }
    `);
    await manifest(dynamic, { id: "lower-file", title: "较低优先级", html: "ignored" });
    await writeFile(join(named, "pages.js"), 'export const pages = [{ id: "named", title: "命名导出", html: "named" }];');
    await writeFile(join(preferred, "page.js"), `
      export const pages = [{ id: "ignored-named", title: "被默认导出取代", html: "ignored" }];
      export default { id: "default", title: "默认导出", html: "default" };
    `);
    const marker = join(notLoaded, "executed");
    await writeFile(join(notLoaded, "index.js"), `await Bun.write(${JSON.stringify(marker)}, "bad");`);

    const result = await loadGuobaPages(new Map([
      ["some plugin", join(dynamic, "..")], ["named", join(named, "..")], ["preferred", join(preferred, "..")],
    ]));
    expect(result.pages.map(({ id }) => id)).toEqual(["batch", "dash", "named", "default"]);
    expect(result.issues).toEqual([
      { plugin: "some plugin", descriptor: "index.js", kind: "duplicate-id", id: "dash" },
    ]);
    expect(await result.resolveAsset("dash", "dash.html")).toMatchObject({ isEntry: true });
    expect(await Bun.file(marker).exists()).toBe(false);

    const apis = result.apis.get("some plugin") ?? [];
    expect(apis.map(({ method, route, handlers }) => [method, route, handlers.length])).toEqual([
      ["get", "/rules/:file", 2], ["get", "/", 1], ["patch", "/rules/:file", 1],
    ]);
    expect(apis[0]?.handlers[0]?.name).toBe("middleware");
    const response = await dispatchGuobaApi(new Request("http://127.0.0.1/rules/fixture.txt"), "/rules/fixture.txt", apis);
    expect(await response.json()).toEqual({
      fixture: "middleware", file: "fixture.txt",
    });
    expect(result.pages.map(({ id }) => id)).not.toContain("late");
    expect(apis.map(({ route }) => route)).not.toContain("/late");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("锅巴 Next init 失败或登记无效条目会撤销同插件的页面与 API", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-guoba-pages-rollback-"));
  try {
    const cases = [
      'throw new Error("fixture-private-init");',
      'ctx.registerPage({ id: "unsafe", title: "越界资源", src: "../outside.html" });',
      'ctx.registerApi("CONNECT", "/forbidden", () => undefined);',
      'ctx.registerApi("GET", "/a/../escape", () => undefined);',
      'ctx.registerApi("GET", "//example.test/path", () => undefined);',
      'ctx.registerApi("GET", "/rules/:name/:name", () => undefined);',
      'ctx.registerApi("GET", "/forbidden?x=1", () => undefined);',
      'ctx.registerApi("GET", "/forbidden", "not a function");',
      'ctx.registerApi("GET", "/forbidden");',
    ];
    const sources = new Map<string, string>();
    for (const [index, badStatement] of cases.entries()) {
      const plugin = `invalid-${index}`;
      const path = await directory(root, plugin);
      sources.set(plugin, join(path, ".."));
      await writeFile(join(path, "index.js"), `
        export async function init(ctx) {
          ctx.registerPage({ id: "partial", title: "不应保留", html: "未完成" });
          ctx.registerApi("POST", "/partial-api", () => "未完成");
          await Promise.resolve();
          ${badStatement}
        }
      `);
      await manifest(path, { id: "lower", title: "不应回退读取", html: "ignored" });
    }
    const healthy = await directory(root, "healthy");
    sources.set("healthy", join(healthy, ".."));
    await manifest(healthy, { id: "partial", title: "合法插件可占用该 ID", html: "正常" });

    const result = await loadGuobaPages(sources);
    expect(result.pages.map(({ id, plugin }) => [id, plugin])).toEqual([["partial", "healthy"]]);
    expect([...result.apis]).toEqual([]);
    expect(result.issues).toEqual(cases.map((_, index) => ({
      plugin: `invalid-${index}`, descriptor: "index.js", kind: "invalid",
    } as const)));
    expect(JSON.stringify(result.issues)).not.toContain("fixture-private-init");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
