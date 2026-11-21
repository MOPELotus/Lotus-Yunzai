import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelDouyin } from "../lib/panel-douyin.ts";
import { panelApi } from "../lib/panel.ts";
import { loadGlobalConfig } from "../plugins/media/core/config/global.ts";
import { normalizeDouyinWork } from "../plugins/media/services/douyin/model.ts";
import { DouyinService, normalizeDouyinDownloadConfig } from "../plugins/media/services/douyin/service.ts";

const endpoint = "/panel/api/settings/media/douyin";
const token = "douyin-panel-fixture";
function request(method = "GET", data?: unknown, authenticated = true) {
  return new Request(`http://localhost${endpoint}`, {
    method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

test("面板只读写抖音现有九个公开选项，下载服务采用保存后的配置", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-panel-douyin-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    const legacyDir = join(dir, "plugins/Lotus-Plugin/config");
    await mkdir(legacyDir, { recursive: true });
    await mkdir(join(dir, "config"));
    const inherited = "douyin:\n  request_timeout_ms: '12500'\n  hidden: fixture-douyin-private\n" +
      "  download: { tools_path: fixture-local-tool-path, hidden: fixture-download-private }\n";
    const inheritedFile = join(legacyDir, "global.yaml");
    await writeFile(inheritedFile, inherited);
    const file = join(dir, "config/global.yaml");
    const prior = "# 原配置\r\nbilibili: {search_limit: 5}\r\npermissions: { scopes: { douyin.download: {policy: deny} } }\r\n";
    await writeFile(file, prior);
    const route = panelDouyin(root);
    const panel = panelApi(token, [], path => path === endpoint ? route : undefined);
    expect((await panel(request("GET", undefined, false)))?.status).toBe(401);
    const beforeText = await (await panel(request()))!.text();
    for (const hidden of ["fixture-local-tool-path", "fixture-douyin-private", "fixture-download-private"]) expect(beforeText).not.toContain(hidden);
    const before = JSON.parse(beforeText);
    expect(before.settings).toEqual({ enable: true, request_timeout_ms: 12500, download_enabled: true, quality: "adapt",
      duration_limit_seconds: 3600, video_size_limit_mb: 100, max_estimated_size_mb: 0, multi_page_policy: "zip", timeout_ms: 600000 });
    for (const patch of [{ enable: "true" }, { download_enabled: 1 }, { quality: "unknown" }, { request_timeout_ms: 0 },
      { duration_limit_seconds: -1 }, { video_size_limit_mb: 0 }, { multi_page_policy: "archive" }, { tools_path: "never-used" }, { cookie: "fixture" }]) {
      expect((await panel(request("PUT", { patch, revision: before.revision })))?.status).toBe(400);
    }
    const patch = { enable: false, request_timeout_ms: 7800, download_enabled: true, quality: "720p",
      duration_limit_seconds: 7, video_size_limit_mb: 8, max_estimated_size_mb: 1, multi_page_policy: "first", timeout_ms: 9000 } as const;
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
    expect((await panel(request("PUT", { patch: { request_timeout_ms: 6500 }, revision: before.revision })))?.status).toBe(409);
    expect(await readFile(inheritedFile, "utf8")).toBe(inherited);
    expect(await readFile(file, "utf8")).toStartWith(prior);
    const config = await loadGlobalConfig(root);
    expect(config.permissions.scopes["douyin.download"]).toEqual({ policy: "deny" });
    expect(config.douyin).toMatchObject({ enable: false, request_timeout_ms: 7800, hidden: "fixture-douyin-private",
      download: { tools_path: "fixture-local-tool-path", hidden: "fixture-download-private" } });
    const normalized = normalizeDouyinDownloadConfig(config.douyin);
    const { enable, request_timeout_ms, download_enabled, ...downloads } = patch;
    expect(normalized).toEqual({ ...downloads, enable: download_enabled, tools_path: "fixture-local-tool-path" });

    const fetched: string[] = [];
    const prepared: { tools_path?: string; timeout_ms?: number }[] = [];
    let responseLength = 12;
    const service = new DouyinService({ tasksDir: join(dir, "tasks"), timeoutMs: config.douyin.request_timeout_ms,
      fetch: async (url) => {
        fetched.push(url);
        return new Response(new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]),
          { headers: { "Content-Length": String(responseLength) } });
      }, async prepareVideo(output, options) { prepared.push(options); return { file: output, warnings: [] }; } });
    expect(service.timeoutMs).toBe(7800);
    const work = normalizeDouyinWork({ aweme_id: "123456789", desc: "offline", duration: 6000,
      video: { play_addr: { url_list: ["https://www.douyincdn.com/fixture"] } } });
    const videoSources = [{ quality: "1080p", urls: ["https://www.douyincdn.com/1080"] },
      { quality: "720p", urls: ["https://www.douyincdn.com/720"] }];
    const video = { ...work, duration: 6, media: [{ index: 1, type: "video", urls: [], sources: videoSources },
      { index: 2, type: "video", urls: [], sources: [{ urls: ["https://www.douyincdn.com/ignored"] }] }] } as typeof work;
    service.getInfo = async () => video;
    const result = await service.download(video, normalized);
    expect(result.ok && "files" in result && result.files.length).toBe(1);
    expect(fetched).toEqual(["https://www.douyincdn.com/720"]);
    expect(prepared[0]?.tools_path).toBe("fixture-local-tool-path");
    expect(prepared[0]?.timeout_ms).toBeGreaterThan(0);
    expect(prepared[0]?.timeout_ms).toBeLessThanOrEqual(9000);
    if (result.ok && "taskDir" in result) await service.releaseTask(result);
    expect(await service.download({ ...video, duration: 8 }, normalized)).toMatchObject({ ok: false, reason: "duration_limit", limitSeconds: 7 });
    responseLength = 1024 * 1024 + 1;
    await expect(service.download(video, normalized)).rejects.toThrow("媒体大小超过下载限制");
    expect((await panel(request("PUT", { patch: before.settings, revision: after.revision })))?.status).toBe(200);
    expect((await (await panel(request()))!.json()).settings).toEqual(before.settings);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("抖音旧平铺配置的解析与下载开关可独立修改，保留有效工具目录、共享 YAML 和零时长", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-panel-douyin-yaml-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    await mkdir(join(dir, "config"));
    const file = join(dir, "config/global.yaml");
    const route = panelDouyin(root);
    const source = "# 共享旧配置\nshared: &shared { enable: false, duration_limit_seconds: 0, quality: 540p, tools_path: fixture-tool }\n" +
      "douyin: *shared # 原引用\n";
    await writeFile(file, source);
    const before = await (await route(request(), () => true)).json();
    expect(before.settings).toMatchObject({ enable: false, download_enabled: false, duration_limit_seconds: 0, quality: "540p" });
    const changed = await route(request("PUT", { patch: { enable: true }, revision: before.revision }), () => true);
    expect(changed.status).toBe(200);
    expect((await changed.json()).settings).toMatchObject({ enable: true, download_enabled: false, duration_limit_seconds: 0, quality: "540p" });
    const config = await loadGlobalConfig(root);
    expect(config.douyin.enable).toBe(true);
    expect(normalizeDouyinDownloadConfig(config.douyin)).toMatchObject({ enable: false, quality: "540p", duration_limit_seconds: 0, tools_path: "fixture-tool" });
    const saved = await readFile(file, "utf8");
    expect(saved).toContain("shared: &shared { enable: false, duration_limit_seconds: 0, quality: 540p, tools_path: fixture-tool }");
    expect(saved).toContain("douyin: {<<: *shared,");
    expect(saved).toContain("# 原引用");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
