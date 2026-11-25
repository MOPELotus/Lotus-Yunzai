import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { createI18n, defaultLanguage, formatMessage } from "./index.ts";

test("a new registry includes only Chinese; namespaces, variables and fallback remain independent", () => {
  const i18n = createI18n();
  const user = i18n.createTranslator("account", { greeting: "你好，{name}。", remaining: "剩余 {count} 次。" });
  const logs = i18n.createTranslator("logs", { greeting: "已登录。" });
  expect(i18n.listLanguages()).toEqual([defaultLanguage]);
  expect(user("greeting", { name: "甲" })).toBe("你好，甲。");
  i18n.registerLanguage("en", { account: { greeting: "Hello, {name}." } });
  expect(i18n.setLanguage("en")).toBe("en");
  expect(user("greeting", { name: "A" })).toBe("Hello, A.");
  expect(user("remaining", { count: 0 })).toBe("剩余 0 次。");
  expect(logs("greeting")).toBe("已登录。");
  expect(user("missing")).toBe("account.missing");
  expect(() => i18n.setLanguage("ja")).toThrow("not registered");
});

test("catalogs merge atomically and safely handle reserved object keys without exposing mutable state", () => {
  const i18n = createI18n();
  const t = i18n.createTranslator("__proto__", JSON.parse('{"constructor":"原文","__proto__":"安全"}'));
  i18n.registerCatalog("en", "__proto__", { constructor: "translated" });
  i18n.registerLanguage("en", { account: { ok: "OK" } });
  i18n.setLanguage("en");
  expect(t("constructor")).toBe("translated");
  expect(t("__proto__")).toBe("安全");
  const invalid = { account: { ok: "changed" }, other: { bad: 1 } } as unknown as Parameters<typeof i18n.registerLanguage>[1];
  expect(() => i18n.registerLanguage("en", invalid)).toThrow("entry");
  const snapshot = i18n.getCatalog("en");
  expect(snapshot.account!.ok).toBe("OK");
  (snapshot.account as Record<string, string>).ok = "outside";
  expect(i18n.getCatalog("en").account!.ok).toBe("OK");
  expect(Object.getPrototypeOf(snapshot)).toBeNull();
});

test("custom Chinese text survives a plugin registering its bundled fallback later", () => {
  const i18n = createI18n();
  i18n.registerLanguage("zh-CN", { plugin: { ready: "自定义中文" } });
  const t = i18n.createTranslator("plugin", { ready: "原中文", stopped: "停止" });
  expect(t("ready")).toBe("自定义中文");
  expect(t("stopped")).toBe("停止");
  expect(i18n.getCatalog("zh-CN", "plugin").plugin).toEqual({ ready: "自定义中文", stopped: "停止" });
  i18n.registerLanguage("en", {});
  i18n.setLanguage("en");
  expect(t("ready")).toBe("自定义中文");
  expect(i18n.getCatalog("en", "plugin").plugin!.ready).toBe("自定义中文");
});

test("formatting preserves missing variables and inserts untrusted values only once", () => {
  expect(formatMessage("{a}:{b}:{c}:{d}:{e}", { a: "{b}", b: false, c: null, d: 4n, e: undefined })).toBe("{b}:false:null:4:undefined");
  expect(formatMessage("缺少 {name}", {})).toBe("缺少 {name}");
  expect(formatMessage("{constructor}", {})).toBe("{constructor}");
  expect(formatMessage("{a}", Object.create({ a: "inherited" }))).toBe("{a}");
});

test("per-request async language context cannot leak into another request or change the default", async () => {
  const context = new AsyncLocalStorage<string>();
  const i18n = createI18n();
  const t = i18n.createTranslator("runtime", { ready: "就绪" });
  i18n.registerLanguage("en", { runtime: { ready: "Ready" } });
  i18n.setLanguageResolver(() => context.getStore());
  const [english, chinese] = await Promise.all([
    context.run("en", async () => { await Bun.sleep(5); return t("ready"); }),
    context.run("zh-CN", async () => { await Bun.sleep(1); return t("ready"); }),
  ]);
  expect([english, chinese, t("ready")]).toEqual(["Ready", "就绪", "就绪"]);
  expect(context.run("not_a_valid_locale!", () => t("ready"))).toBe("就绪");
  expect(context.run("ja", () => t("ready"))).toBe("就绪");
});

test("language names normalize, selection notifies once and unsubscribed observers stay silent", () => {
  const i18n = createI18n();
  const observed: string[] = [];
  const stop = i18n.subscribeLanguageChange(value => observed.push(value));
  i18n.registerLanguage("en_us", {});
  expect(i18n.listLanguages()).toEqual(["zh-CN", "en-US"]);
  expect(i18n.setLanguage("en-us")).toBe("en-US");
  i18n.setLanguage("en-US");
  stop();
  i18n.setLanguage("zh_CN");
  expect(observed).toEqual(["en-US"]);
  expect(() => i18n.registerLanguage("../../en", {})).toThrow("language tag");
  expect(() => i18n.registerLanguage("en", { "": {} })).toThrow("namespace");
});

test("replacing and removing a language drops obsolete entries without removing bundled Chinese", () => {
  const i18n = createI18n();
  const t = i18n.createTranslator("plugin", { ready: "就绪", stopped: "停止" });
  i18n.registerLanguage("en", { plugin: { ready: "Ready", stopped: "Stopped" } });
  i18n.setLanguage("en");
  i18n.replaceLanguage("en", { plugin: { ready: "Available" } });
  expect(t("ready")).toBe("Available");
  expect(t("stopped")).toBe("停止");
  i18n.removeLanguage("en");
  expect(i18n.getLanguage()).toBe("zh-CN");
  expect(i18n.listLanguages()).toEqual(["zh-CN"]);
  i18n.registerLanguage("zh-CN", { plugin: { ready: "更改" } });
  i18n.removeLanguage("zh-CN");
  expect(t("ready")).toBe("就绪");
});
