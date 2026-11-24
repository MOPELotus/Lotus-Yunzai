import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { enablePartnerAfterLogin, panelPartner } from "../lib/panel-partner.ts";
import { panelApi } from "../lib/panel.ts";
import { HandlerScope } from "../lib/plugins/handler.ts";
import { LegacyTasks } from "../lib/plugins/tasks.ts";
import { loadGlobalConfig } from "../plugins/media/core/config/global.ts";
import { createPartnerSchedule } from "../plugins/media/services/music/partner-schedule.ts";

const endpoint = "/panel/api/settings/media/partner";
const token = "partner-panel-fixture";
function request(method = "GET", data?: unknown, authenticated = true) {
  return new Request(`http://localhost${endpoint}`, {
    method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

function validTask(cron: string) {
  try {
    const task = new LegacyTasks().prepare([{ owner: new HandlerScope(), app: { name: "Partner fixture", task: { cron, fnc() {} } } }]);
    task.cancel();
    return true;
  } catch { return false; }
}

test("面板保存合伙人配置后现有任务继续使用注册时刻并在下一轮读取选项，重启才更换 Cron", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-panel-partner-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    const legacyDir = join(dir, "plugins/Lotus-Plugin/config");
    await mkdir(legacyDir, { recursive: true });
    await mkdir(join(dir, "config"));
    const inherited = "netease_partner:\n  schedule: '0 50 23 * * ? *'\n  hidden: test-nonpublic-field\n" +
      "  review: { mode: responses, api_key: test-secret-key, api_url: https://fixture.invalid/private-url," +
      " model: test-private-model, codex_command: test-executable-path }\n";
    const inheritedFile = join(legacyDir, "global.yaml");
    await writeFile(inheritedFile, inherited);
    const file = join(dir, "config/global.yaml");
    const prior = "# 原配置\r\nmusic: {search_limit: 5}\r\npermissions: { scopes: { netease.partner: {policy: deny} } }\r\n";
    await writeFile(file, prior);
    const route = panelPartner(root, validTask);
    const panel = panelApi(token, [], path => path === endpoint ? route : undefined);
    expect((await panel(request("GET", undefined, false)))?.status).toBe(401);
    const beforeText = await (await panel(request()))!.text();
    for (const hidden of ["test-nonpublic-field", "test-secret-key", "private-url", "test-executable-path"]) {
      expect(beforeText).not.toContain(hidden);
    }
    const before = JSON.parse(beforeText);
    expect(before.reviewMode).toBe("responses");
    expect(before.review).toEqual({ model: "test-private-model", apiOrigin: "https://fixture.invalid",
      apiUrlConfigured: true, apiKeyConfigured: true, customCodexCommand: true });
    expect(before.settings).toEqual({ enable: false, schedule: "0 50 23 * * ? *", auto_catch_up: false, notify_master: true,
      login_timeout_ms: 300000, login_poll_ms: 3000, delay_ms_min: 8000, delay_ms_max: 11000,
      comments: ["打卡支持"], review_max_chars: 140, review_timeout_ms: 180000 });
    for (const patch of [{ review_mode: "codex" }, { review_codex_command: "fixture-run" }, { codex_command: "fixture-run" }, { api_key: "never-used" },
      { login_poll_ms: 0 }, { review_max_chars: 501 }, { delay_ms_min: 300001 }, { comments: ["a".repeat(501)] }]) {
      expect((await panel(request("PUT", { patch, revision: before.revision })))?.status).toBe(400);
    }
    for (const [patch, field] of [[{ schedule: "80 3 * * * *" }, "schedule"], [{ delay_ms_max: 5 }, "delay_ms_max"]] as const) {
      const badResult = (await panel(request("PUT", { patch, revision: before.revision })))!;
      expect(badResult.status).toBe(400);
      expect(await badResult.json()).toEqual({ field });
    }
    const scheduled: { cron: string; run: () => Promise<unknown> }[] = [];
    const seen: unknown[] = [];
    let ready: (() => void) | undefined;
    let notified = 0;
    let startupWait = 0;
    const instance = () => createPartnerSchedule({ mediaRuntime: {
      whenReady(start) { ready = start; return () => { ready = undefined; }; },
      registerTask(cron, run) { scheduled.push({ cron, run }); return async () => {}; },
      async notifyMasters() { notified++; },
    } }, { load: () => loadGlobalConfig(root), now: () => new Date(2026, 10, 22, 1, 0, 0),
      async wait() { startupWait++; }, async hasRunToday() { return false; },
      async execute(config, trigger, { once }) { seen.push([config.netease_partner, trigger, once]); return { trigger, time: "fixtures", accounts: [] }; },
      async render() { return { text: "fixture" }; },
    });
    const stop = await instance();
    ready?.();
    expect(scheduled[0]?.cron).toBe("0 50 23 * * *");
    await scheduled[0]?.run();
    expect(seen).toHaveLength(0);
    const patch = { enable: true, schedule: "0 15 23 * * ? *", auto_catch_up: true, notify_master: false,
      login_timeout_ms: 60000, login_poll_ms: 1500, delay_ms_min: 1000, delay_ms_max: 1400,
      comments: ["样本短评", "另外一条"], review_max_chars: 73, review_timeout_ms: 9000 };
    let active = true;
    expect((await route(request("PUT", { patch, revision: before.revision }), () => {
      const allowed = active;
      active = false;
      return allowed;
    })).status).toBe(401);
    expect(await readFile(file, "utf8")).toBe(prior);
    const saved = (await panel(request("PUT", { patch, revision: before.revision })))!;
    expect(saved.status).toBe(200);
    const after = await saved.json();
    expect(after.settings).toEqual(patch);
    expect(after.reviewMode).toBe("responses");
    expect(scheduled).toHaveLength(1);
    expect(seen).toHaveLength(0);
    expect(startupWait).toBe(0);
    await scheduled[0]?.run();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject([{ enable: true, schedule: patch.schedule, comments: patch.comments, review: { max_chars: 73, timeout_ms: 9000 } }, "自动任务", true]);
    expect(notified).toBe(0);
    await stop?.();
    const restart = await instance();
    ready?.();
    expect(scheduled[1]?.cron).toBe("0 15 23 * * *");
    expect(startupWait).toBe(0);
    await restart?.();
    expect((await panel(request("PUT", { patch: { enable: false }, revision: before.revision })))?.status).toBe(409);
    expect(await readFile(inheritedFile, "utf8")).toBe(inherited);
    expect(await readFile(file, "utf8")).toStartWith(prior);
    const config = await loadGlobalConfig(root);
    expect((config.permissions.scopes as Readonly<Record<string, unknown>>)["netease.partner"]).toEqual({ policy: "deny" });
    expect(config.netease_partner.review).toMatchObject({ mode: "responses", api_key: "test-secret-key", api_url: "https://fixture.invalid/private-url",
      model: "test-private-model", codex_command: "test-executable-path", max_chars: 73, timeout_ms: 9000 });
    expect((await panel(request("PUT", { patch: before.settings, revision: after.revision })))?.status).toBe(200);
    expect((await (await panel(request()))!.json()).settings).toEqual(before.settings);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("评论库和乐评限制分别编辑，保留旧 YAML 共享配置、注释与本机字段", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-panel-partner-yaml-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    await mkdir(join(dir, "config"));
    const file = join(dir, "config/global.yaml");
    const route = panelPartner(root, validTask);
    const source = "# 共享旧配置\r\nshared: &shared { mode: codex, codex_command: fixture-local, max_chars: 140 }\r\n" +
      "netease_partner:\r\n  # 旧评论位置\r\n  comments: # 保留注释\r\n  - 旧评论\r\n  review: *shared # 原引用\r\n";
    await writeFile(file, source);
    const before = await (await route(request(), () => true)).json();
    expect(before.settings.comments).toEqual(["旧评论"]);
    const changed = await route(request("PUT", { patch: { comments: ["样本一", " 样本一 ", "样本二"], review_max_chars: 60 }, revision: before.revision }), () => true);
    expect(changed.status).toBe(200);
    const after = await changed.json();
    expect(after.settings.comments).toEqual(["样本一", "样本二"]);
    const current = await readFile(file, "utf8");
    expect(current).toContain("shared: &shared { mode: codex, codex_command: fixture-local, max_chars: 140 }");
    expect(current).toContain("comments: # 保留注释\r\n");
    expect(current).toContain("review: {<<: *shared, max_chars: 60} # 原引用\r\n");
    const changedBack = await route(request("PUT", { patch: { comments: [], schedule: "" }, revision: after.revision }), () => true);
    expect(changedBack.status).toBe(200);
    const result = await changedBack.json();
    expect(result.settings.comments).toEqual(["打卡支持"]);
    expect(result.settings.schedule).toBe("0 5 0 * * ? *");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("合伙人扫码确认后的定时启用保留原有选项并检查权限与取消", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-partner-login-settings-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    const file = join(dir, "config/global.yaml");
    const oldFile = join(dir, "plugins/Lotus-ReFactor/config/global.yaml");
    await mkdir(join(dir, "config"));
    await mkdir(join(dir, "plugins/Lotus-ReFactor/config"), { recursive: true });
    const original = "# unrelated\nmusic: { search_limit: 8 }\n";
    const inherited = "netease_partner: { enable: false, schedule: '0 55 23 * * *', review: { mode: codex, max_chars: 80 } }\n";
    await writeFile(file, original);
    await writeFile(oldFile, inherited);

    const active = new AbortController();
    await expect(enablePartnerAfterLogin(root, active.signal, () => false)).rejects.toThrow("permission");
    await expect(enablePartnerAfterLogin(root, AbortSignal.abort(), () => true)).rejects.toThrow("cancelled");
    expect(await readFile(file, "utf8")).toBe(original);

    await enablePartnerAfterLogin(root, active.signal, effective => effective.music != null);
    expect((await loadGlobalConfig(root)).netease_partner).toEqual({
      enable: true, schedule: "0 55 23 * * *", review: { mode: "codex", max_chars: 80 },
    });
    expect(await readFile(oldFile, "utf8")).toBe(inherited);
    const enabled = await readFile(file, "utf8");
    expect(enabled).toStartWith(original);
    await enablePartnerAfterLogin(root, active.signal, () => true);
    expect(await readFile(file, "utf8")).toBe(enabled);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("主人编辑乐评模型和 Responses 接口，密钥只写并保护旧凭据和并发变更", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-partner-review-edit-"));
  try {
    const root = pathToFileURL(`${directory}/`);
    await mkdir(join(directory, "config"));
    const file = join(directory, "config/global.yaml");
    const original = "netease_partner:\n  review: { mode: fixed, model: local-original-model, api_key: test-review-original, api_url: 'https://old.invalid/private-path' }\n";
    await writeFile(file, original);
    const route = panelPartner(root, validTask);
    const panel = panelApi(token, [], path => path === endpoint ? route : undefined);
    const update = async (revision: string, patch: Record<string, unknown>) => (await panel(request("PUT", { revision, patch })))!;
    const current = async () => (await panel(request()))!;

    const before = await current();
    expect(before.headers.get("Cache-Control")).toBe("no-store");
    const redacted = await before.text();
    expect(redacted).not.toContain("test-review-original");
    expect(redacted).not.toContain("/private-path");
    const snapshot = JSON.parse(redacted);
    expect(snapshot.review).toEqual({ model: "local-original-model", apiOrigin: "https://old.invalid", apiUrlConfigured: true,
      apiKeyConfigured: true, customCodexCommand: false });
    expect((await panel(request("PUT", { revision: snapshot.revision, patch: { review_api_key: "unauthorized-fixture" } }, false)))?.status).toBe(401);
    let stillActive = true;
    expect((await route(request(), () => {
      const result = stillActive;
      stillActive = false;
      return result;
    })).status).toBe(401);
    for (const url of ["http://provider.invalid/v1/responses", "https://user:pass@provider.invalid/v1/responses",
      "https://provider.invalid/v1/responses?secret=fixture", "https://provider.invalid/v1/responses#", "file:///tmp/settings"]) {
      const result = await update(snapshot.revision, { review_api_url: url });
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ field: "review_api_url" });
    }
    const rebound = await update(snapshot.revision, { review_api_url: "https://new.invalid/v1/responses", review_api_key: "" });
    expect(rebound.status).toBe(400);
    expect(await rebound.json()).toEqual({ field: "review_api_url_key" });
    const contradictory = await update(snapshot.revision, { review_api_key: "test-review-new", review_clear_api_key: true });
    expect(contradictory.status).toBe(400);
    const malformed = await update(snapshot.revision, { review_api_key: "test\nreview" });
    expect(malformed.status).toBe(400);
    expect(await readFile(file, "utf8")).toBe(original);

    const switched = await update(snapshot.revision, { review_mode: "responses", review_model: "demo/model-v2",
      review_api_url: "http://127.0.0.1:8237/v1/responses", review_api_key: "test-review-new" });
    expect(switched.status).toBe(200);
    const body = await switched.text();
    expect(body).not.toContain("test-review-new");
    expect(body).not.toContain("/v1/responses");
    const configured = JSON.parse(body);
    expect(configured.reviewMode).toBe("responses");
    expect(configured.review).toEqual({ model: "demo/model-v2", apiOrigin: "http://127.0.0.1:8237", apiUrlConfigured: true,
      apiKeyConfigured: true, customCodexCommand: false });
    const config = await loadGlobalConfig(root);
    expect(config.netease_partner.review).toMatchObject({ mode: "responses", model: "demo/model-v2",
      api_url: "http://127.0.0.1:8237/v1/responses", api_key: "test-review-new" });
    expect((await update(configured.revision, { review_api_key: "   " })).status).toBe(200);
    const stored = await readFile(file, "utf8");
    expect(stored).toContain("test-review-new");

    // An out-of-band key rotation changes the revision even though the public status is still "configured".
    await writeFile(file, stored.replace("test-review-new", "test-review-rotated"));
    const following = await (await current()).json();
    expect(following.review).toEqual(configured.review);
    expect(following.revision).not.toBe(configured.revision);
    expect((await update(configured.revision, { review_model: "retry-new-model" })).status).toBe(409);
    const cleared = await update(following.revision, { review_clear_api_key: true, review_api_url: "" });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).review).toEqual({ model: "demo/model-v2", apiOrigin: "https://api.openai.com",
      apiUrlConfigured: false, apiKeyConfigured: false, customCodexCommand: false });
    expect((await loadGlobalConfig(root)).netease_partner.review).toMatchObject({ api_url: "", api_key: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("迁移后的乐评和自定义 Codex 程序需要本机确认，面板补齐其他设置", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-partner-review-local-"));
  try {
    const root = pathToFileURL(`${directory}/`);
    await mkdir(join(directory, "config"));
    const file = join(directory, "config/global.yaml");
    const source = "netease_partner: { enable: false, review: { mode: disabled } }\n";
    await writeFile(file, source);
    const route = panelPartner(root, validTask);
    const load = async () => (await route(request(), () => true)).json();
    const update = async (revision: string, patch: Record<string, unknown>) =>
      route(request("PUT", { revision, patch }), () => true);
    const pending = await load();
    expect(pending.reviewMode).toBe("disabled");
    for (const patch of [{ review_mode: "fixed" }, { review_mode: "responses" }, { enable: true }]) {
      const result = await update(pending.revision, patch);
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ field: "review_local" });
    }
    await expect(enablePartnerAfterLogin(root, new AbortController().signal, () => true)).rejects.toThrow("review_local");
    expect(await readFile(file, "utf8")).toBe(source);
    const settings = await update(pending.revision, { comments: ["迁移后仍可修改固定评论库"] });
    expect(settings.status).toBe(200);
    expect((await settings.json()).reviewMode).toBe("disabled");

    // A deployment edit can confirm mode and specify an executable; its path stays in local YAML.
    await writeFile(file, "netease_partner: { enable: false, review: { mode: fixed, codex_command: local-trusted-command } }\n");
    const local = await load();
    expect(local.reviewMode).toBe("fixed");
    expect(local.review.customCodexCommand).toBe(true);
    expect(JSON.stringify(local)).not.toContain("local-trusted-command");
    expect((await update(local.revision, { review_codex_command: "new-command" })).status).toBe(400);
    const activation = await update(local.revision, { review_mode: "codex" });
    expect(activation.status).toBe(400);
    expect(await activation.json()).toEqual({ field: "review_local" });
    await writeFile(file, "netease_partner: { enable: false, review: { mode: fixed } }\n");
    const defaults = await load();
    const needsCredentials = await update(defaults.revision, { review_mode: "responses", review_model: "demo-model" });
    expect(needsCredentials.status).toBe(400);
    expect(await needsCredentials.json()).toEqual({ field: "review_responses" });
    const builtinCodex = await update(defaults.revision, { review_mode: "codex", review_model: "gpt-fixture" });
    expect(builtinCodex.status).toBe(200);
    expect((await builtinCodex.json()).reviewMode).toBe("codex");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
