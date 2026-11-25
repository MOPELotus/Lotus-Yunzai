import { expect, test } from "bun:test";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createI18n } from "../packages/i18n/index.ts";
import { createI18nSettings, panelI18n } from "../lib/i18n-settings.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lotus-i18n-settings-"));
  const runtime = createI18n();
  const doc = { language: "zh-CN", name: "简体中文", namespace: "core", description: "机器人回执与日志", sections: { login: { description: "登录", source: "lib/login.ts" } },
    parameters: { welcome: { name: "用户名称" } }, messages: { welcome: "你好，{name}", ready: "已就绪" } };
  await mkdir(join(root, "i18n"));
  await writeFile(join(root, "i18n/zh-CN.json"), JSON.stringify(doc));
  const settings = createI18nSettings(pathToFileURL(root + "/"), { runtime });
  return { root, runtime, doc, settings, close: () => rm(root, { recursive: true, force: true }) };
}

test("bundled catalogs expose explanations and user languages fall back to Chinese", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "plugins/demo/i18n"), { recursive: true });
    await writeFile(join(f.root, "plugins/demo/i18n/zh-CN.json"), JSON.stringify({ namespace: "demo", description: "插件", messages: { ok: "完成" } }));
    await mkdir(join(f.root, "i18n/languages"));
    await writeFile(join(f.root, "i18n/languages/en.json"), JSON.stringify({ name: "English", messages: { core: { welcome: "Hello, {name}" } } }));
    await f.settings.load();
    const before = await f.settings.snapshot();
    expect(before.language).toBe("zh-CN");
    expect(before.languages).toEqual([{ id: "zh-CN", label: "简体中文" }, { id: "en", label: "English" }]);
    expect(before.defaults.core!.sections).toEqual(f.doc.sections);
    expect(before.defaults.core!.parameters).toEqual(f.doc.parameters);
    const snapshot = await f.settings.setLanguage("en");
    expect(snapshot.catalogs.core).toEqual({ welcome: "Hello, {name}", ready: "已就绪" });
    expect(snapshot.catalogs.demo).toEqual({ ok: "完成" });
    expect(snapshot.restartRequired).toBe(true);
    const otherRuntime = createI18n();
    const restarted = createI18nSettings(pathToFileURL(f.root + "/"), { runtime: otherRuntime });
    expect((await restarted.snapshot()).language).toBe("en");
    expect((await restarted.snapshot()).restartRequired).toBe(false);
  } finally { await f.close(); }
});

test("panel edits only private known keys, merge concurrent updates and survive restart", async () => {
  const f = await fixture();
  try {
    const original = await readFile(join(f.root, "i18n/zh-CN.json"), "utf8");
    const api = panelI18n(f.settings);
    const edit = (messages: object) => api(new Request("http://local/panel/api/i18n", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: "zh-CN", namespace: "core", messages }) }), () => true);
    expect((await Promise.all([edit({ ready: "准备好了" }), edit({ welcome: "欢迎 {name}" })])).map(r => r.status)).toEqual([200, 200]);
    expect((await f.settings.snapshot()).catalogs.core).toEqual({ ready: "准备好了", welcome: "欢迎 {name}" });
    expect(await readFile(join(f.root, "i18n/zh-CN.json"), "utf8")).toBe(original);
    expect((await stat(join(f.root, "config/i18n/zh-CN.json"))).mode & 0o777).toBe(0o600);
    expect((await edit({ unknown: "不接受" })).status).toBe(400);
    expect((await api(new Request("http://local/panel/api/i18n", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: "../../escape", namespace: "core", messages: { ready: "x" } }) }), () => true)).status).toBe(400);
    const restarted = createI18nSettings(pathToFileURL(f.root + "/"), { runtime: createI18n() });
    expect((await restarted.snapshot()).catalogs.core!.ready).toBe("准备好了");
  } finally { await f.close(); }
});

test("panel refuses unauthenticated, revoked, malformed and unsupported writes", async () => {
  const f = await fixture();
  try {
    const api = panelI18n(f.settings);
    expect((await api(new Request("http://local/panel/api/i18n"), () => false)).status).toBe(401);
    expect((await api(new Request("http://local/panel/api/i18n", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{" }), () => true)).status).toBe(400);
    expect((await api(new Request("http://local/panel/api/i18n", { method: "DELETE" }), () => true)).status).toBe(405);
    await expect(f.settings.editMessages({ language: "zh-CN", namespace: "core", messages: { ready: "x" } }, { canWrite: () => false })).rejects.toMatchObject({ reason: "permission" });
    await expect(f.settings.setLanguage("zh-CN", { signal: AbortSignal.abort() })).rejects.toMatchObject({ reason: "cancelled" });
    let calls = 0;
    const response = await api(new Request("http://local/panel/api/i18n", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: "zh-CN" }) }), () => ++calls === 1);
    expect(response.status).toBe(401);
    await expect(readFile(join(f.root, "config/i18n/settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.close(); }
});

test("language catalogs cannot be symlinks or exceed the read limit", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "lotus-i18n-outside-"));
  try {
    await mkdir(join(f.root, "config/i18n"), { recursive: true });
    await writeFile(join(outside, "language.json"), JSON.stringify({ messages: { core: { ready: "unsafe" } } }));
    await symlink(join(outside, "language.json"), join(f.root, "config/i18n/en.json"));
    await expect(f.settings.load()).rejects.toMatchObject({ reason: "unsafe-path" });
    await rm(join(f.root, "config/i18n/en.json"));
    await writeFile(join(f.root, "config/i18n/en.json"), " ".repeat(16 * 1024 * 1024 + 1));
    const other = createI18nSettings(pathToFileURL(f.root + "/"), { runtime: createI18n() });
    await expect(other.load()).rejects.toMatchObject({ reason: "too-large" });
    await rm(join(f.root, "config/i18n/en.json"));
    await rm(join(f.root, "config/i18n"), { recursive: true });
    await symlink(outside, join(f.root, "config/i18n"));
    const linked = createI18nSettings(pathToFileURL(f.root + "/"), { runtime: createI18n() });
    await expect(linked.load()).rejects.toMatchObject({ reason: "unsafe-path" });
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});

test("preload applies private language before a plugin caches its top-level message", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "lib"));
    await mkdir(join(f.root, "packages/i18n"), { recursive: true });
    await mkdir(join(f.root, "config/i18n"), { recursive: true });
    await copyFile(new URL("../lib/i18n-preload.ts", import.meta.url), join(f.root, "lib/i18n-preload.ts"));
    await copyFile(new URL("../packages/i18n/index.ts", import.meta.url), join(f.root, "packages/i18n/index.ts"));
    await writeFile(join(f.root, "config/i18n/en.json"), JSON.stringify({ messages: { plugin: { ready: "Ready" } } }));
    await writeFile(join(f.root, "config/i18n/settings.json"), JSON.stringify({ language: "en" }));
    await writeFile(join(f.root, "app.ts"), [
      'import "./lib/i18n-preload.ts";',
      'import {createTranslator,getLanguage} from "./packages/i18n/index.ts";',
      'const ready = createTranslator("plugin", {ready:"已就绪"})("ready");',
      'console.log(JSON.stringify({ready,language:getLanguage()}));',
    ].join("\n"));
    const child = Bun.spawn([process.execPath, "app.ts"], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(JSON.parse(output)).toEqual({ ready: "Ready", language: "en" });
  } finally { await f.close(); }
});

test("real panel discovers newly added languages and drops deleted files and keys without a restart", async () => {
  const f = await fixture();
  try {
    await f.settings.load();
    const api = panelI18n(f.settings);
    await mkdir(join(f.root, "i18n/languages"));
    const path = join(f.root, "i18n/languages/en.json");
    await writeFile(path, JSON.stringify({ name: "English", messages: { core: { ready: "Ready", welcome: "Hello {name}" } } }));
    const listed = await (await api(new Request("http://local/panel/api/i18n"), () => true)).json();
    expect(listed.languages).toContainEqual({ id: "en", label: "English" });
    const changed = await api(new Request("http://local/panel/api/i18n", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: "en" }) }), () => true);
    expect(changed.status).toBe(200);
    expect((await changed.json()).catalogs.core.ready).toBe("Ready");
    await writeFile(path, JSON.stringify({ name: "English updated", messages: { core: { welcome: "Welcome {name}" } } }));
    const updated = await f.settings.snapshot();
    expect(updated.catalogs.core).toEqual({ ready: "已就绪", welcome: "Welcome {name}" });
    expect(updated.languages).toContainEqual({ id: "en", label: "English updated" });
    await rm(path);
    const removed = await f.settings.snapshot();
    expect(removed.language).toBe("zh-CN");
    expect(removed.languages).toEqual([{ id: "zh-CN", label: "简体中文" }]);
    expect(removed.catalogs.core).toEqual(f.doc.messages);
  } finally { await f.close(); }
});
