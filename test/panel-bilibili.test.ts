import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelBilibili } from "../lib/panel-bilibili.ts";
import { panelApi } from "../lib/panel.ts";
import { loadGlobalConfig } from "../plugins/media/core/config/global.ts";
import { BilibiliService, normalizeDownloadConfig } from "../plugins/media/services/bilibili/service.ts";

const path = "/panel/api/settings/media/bilibili";
const token = "bilibili-panel-fixture";
function request(method = "GET", data?: unknown, authenticated = true) {
  return new Request(`http://localhost${path}`, {
    method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

test("B 站面板和媒体运行时兼容旧下载偏好，面板保存后当前字段优先", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-panel-bili-alias-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    const legacy = join(dir, "plugins/Lotus-Plugin/config");
    await mkdir(legacy, { recursive: true });
    await mkdir(join(dir, "config"));
    const historical = "# 旧下载参数\nbilibili:\n  resolution: '80'\n  durationLimit: '71'\n  videoSizeLimit: 89\n  maxSizeLimit: 37\n" +
      "  multiPagePolicy: all\n  download: { video_size_limit_mb: 42 }\nexternal_tools: { toolsPath: /outside/bin }\n";
    await writeFile(join(legacy, "global.yaml"), historical);
    const route = panelBilibili(root);
    const before = await (await route(request(), () => true)).json();
    const settings = { resolution: 80, duration_limit_seconds: 71, video_size_limit_mb: 42, max_estimated_size_mb: 37, multi_page_policy: "all" };
    expect(before.settings).toMatchObject(settings);
    expect(normalizeDownloadConfig((await loadGlobalConfig(root)).bilibili)).toMatchObject({ ...settings, tools_path: "data/tools/bin" });
    const saved = await route(request("PUT", { revision: before.revision, patch: { duration_limit_seconds: 55 } }), () => true);
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toMatchObject({ ...settings, duration_limit_seconds: 55 });
    expect(normalizeDownloadConfig((await loadGlobalConfig(root)).bilibili)).toMatchObject({ ...settings, duration_limit_seconds: 55 });
    expect(await readFile(join(legacy, "global.yaml"), "utf8")).toBe(historical);
    expect(await readFile(join(dir, "config/global.yaml"), "utf8")).not.toContain("/outside/bin");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("B 站面板写入九项视频配置，保留非面板配置和共用登录来源", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-panel-bili-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    const legacyDir = join(dir, "plugins/Lotus-Plugin/config");
    await mkdir(legacyDir, { recursive: true });
    await mkdir(join(dir, "config"));
    const inherited = "bilibili:\n  search_limit: '22'\n  hidden: fixture-bili-private\n" +
      "  download: { tools_path: fixture-local-tool-path, resolution: 55, hidden: fixture-download-private }\n";
    await writeFile(join(legacyDir, "global.yaml"), inherited);
    const file = join(dir, "config/global.yaml");
    const prior = "# 原配置\r\ntuneweave: {api_url: https://fixture.invalid}\r\npermissions: { scopes: { bilibili.login: {policy: deny} } }\r\n";
    await writeFile(file, prior);
    const route = panelBilibili(root);
    const panel = panelApi(token, [], target => target === path ? route : undefined);
    expect((await panel(request("GET", undefined, false)))?.status).toBe(401);
    const beforeText = await (await panel(request()))!.text();
    expect(beforeText).not.toContain("fixture-local-tool-path");
    expect(beforeText).not.toContain("fixture-bili-private");
    expect(beforeText).not.toContain("fixture-download-private");
    const before = JSON.parse(beforeText);
    expect(before.settings).toEqual({ search_limit: 22, enable: true, concurrency: 4, resolution: 55, duration_limit_seconds: 3600,
      video_size_limit_mb: 100, max_estimated_size_mb: 0, multi_page_policy: "zip", timeout_ms: 600000 });
    for (const patch of [{ search_limit: 0 }, { concurrency: 17 }, { max_estimated_size_mb: -1 }, { multi_page_policy: "archive" },
      { timeout_ms: 0.5 }, { tools_path: "never-used" }, { sharedBiliLogin: false }, { cookie: "fixture" }]) {
      expect((await panel(request("PUT", { patch, revision: before.revision })))?.status).toBe(400);
    }
    const patch = { enable: false, search_limit: 7, concurrency: 3, resolution: 80, duration_limit_seconds: 73,
      video_size_limit_mb: 40, max_estimated_size_mb: 50, multi_page_policy: "first", timeout_ms: 9000 } as const;
    let active = true;
    expect((await route(request("PUT", { patch, revision: before.revision }), () => {
      const allowed = active;
      active = false;
      return allowed;
    })).status).toBe(401);
    expect(await readFile(file, "utf8")).toBe(prior);
    const response = (await panel(request("PUT", { patch, revision: before.revision })))!;
    expect(response.status).toBe(200);
    const after = await response.json();
    expect(after.settings).toEqual(patch);
    expect((await panel(request("PUT", { patch: { search_limit: 8 }, revision: before.revision })))?.status).toBe(409);
    expect(await readFile(join(legacyDir, "global.yaml"), "utf8")).toBe(inherited);
    expect(await readFile(file, "utf8")).toStartWith(prior);
    const config = await loadGlobalConfig(root);
    expect(config.permissions.scopes["bilibili.login"]).toEqual({ policy: "deny" });
    expect(config.bilibili).toMatchObject({ search_limit: 7, hidden: "fixture-bili-private",
      download: { tools_path: "fixture-local-tool-path", hidden: "fixture-download-private" } });
    const normalized = normalizeDownloadConfig(config.bilibili);
    const { search_limit, ...download } = patch;
    expect(normalized).toEqual({ ...download, tools_path: "fixture-local-tool-path" });
    const seen: URL[] = [];
    const service = new BilibiliService({ searchLimit: search_limit, accountFile: join(dir, "bilibili-account.json"),
      tuneweaveConfig: { api_url: "https://fixture.invalid" }, fetch: async () => { throw new Error("No external network"); } });
    service.tuneweave.request = (async (address: string) => {
      seen.push(new URL(address, "https://fixture.invalid"));
      return [];
    }) as typeof service.tuneweave.request;
    expect(await service.search("test", { page: 2 })).toEqual([]);
    expect(Object.fromEntries(seen[0]!.searchParams)).toMatchObject({ platform: "bilibili", limit: "7", offset: "7" });
    const video = { type: "video", ref: "fixture", duration: 72, url: "https://fixture.invalid/video", title: "Test", owner: "Fixture",
      cover: "", desc: "", description: "", stat: {}, pages: [{ index: 1, page: 1 }, { index: 2, page: 2 }] } as const;
    service.getInfo = async () => ({ ...video, pages: [...video.pages] });
    const plan = await service.buildDownloadPlan("fixture", config.bilibili);
    expect(plan).toMatchObject({ ok: true, policy: "first", pages: [{ index: 1, page: 1 }] });
    service.getInfo = async () => ({ ...video, duration: 74, pages: [...video.pages] });
    expect(await service.buildDownloadPlan("fixture", config.bilibili)).toMatchObject({ ok: false, reason: "duration_limit", limitSeconds: 73 });
    expect((await panel(request("PUT", { patch: before.settings, revision: after.revision })))?.status).toBe(200);
    expect((await (await panel(request()))!.json()).settings).toEqual(before.settings);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("B 站面板在旧扁平参数或共享 YAML 上只覆盖所改字段，保留工具目录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-panel-bili-yaml-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    await mkdir(join(dir, "config"));
    const file = join(dir, "config/global.yaml");
    const route = panelBilibili(root);
    const sources = [
      "# 平面旧配置\nbilibili: { concurrency: 6, resolution: 48, tools_path: fixture-flat-tool-path }\n",
      "# 共享旧配置\nshared: &shared { concurrency: 6, resolution: 48, tools_path: fixture-flat-tool-path }\n" +
      "bilibili:\n  download: *shared # 保留原引用\n",
    ];
    for (const source of sources) {
      await writeFile(file, source);
      const before = await (await route(request(), () => true)).json();
      expect(before.settings.concurrency).toBe(6);
      const changed = await route(request("PUT", { patch: { search_limit: 15, concurrency: 5 }, revision: before.revision }), () => true);
      expect(changed.status).toBe(200);
      const config = await loadGlobalConfig(root);
      expect(normalizeDownloadConfig(config.bilibili)).toMatchObject({ resolution: 48, concurrency: 5, tools_path: "fixture-flat-tool-path" });
      if (source.includes("&shared")) {
        const saved = await readFile(file, "utf8");
        expect(saved).toContain("shared: &shared { concurrency: 6, resolution: 48, tools_path: fixture-flat-tool-path }");
        expect(saved).toContain("download: {<<: *shared, concurrency: 5} # 保留原引用");
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
