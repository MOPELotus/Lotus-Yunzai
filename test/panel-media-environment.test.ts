import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { panelMediaEnvironment } from "../lib/panel-media-environment.ts";
import { panelApi } from "../lib/panel.ts";
import { loadGlobalConfig } from "../plugins/media/core/config/global.ts";
import { normalizeToolsConfig, ToolInstallerService } from "../plugins/media/services/tools/installer.ts";
import { TuneWeaveService } from "../plugins/media/services/tuneweave/service.ts";
import { startMediaMaintenance } from "../plugins/media/services/tuneweave/startup.ts";

const path = "/panel/api/settings/media/environment";
const token = "media-environment-fixture";
function request(method = "GET", data?: unknown, authenticated = true) {
  return new Request(`http://localhost${path}`, {
    method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

test("面板可只改安装与请求参数，旧路径、服务来源与已存在的安装权限保持", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-panel-media-environment-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    const legacyDir = join(dir, "plugins/Lotus-Plugin/config");
    const secondDir = join(dir, "plugins/Lotus-ReFactor/config");
    await mkdir(legacyDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    await mkdir(join(dir, "config"));
    const toolsDir = join(dir, "fixture-local-tools");
    const binDir = join(dir, "fixture-bin");
    const source = `tools:\n  dir: ${toolsDir}\n  bin_dir: ${binDir}\n` +
      "  github_api: https://fixture.invalid/private-release\n  ffmpeg: { command: unique-nonexistent-fixture-command, repo: fixture/test-repo }\n" +
      "  download_retries: '4'\ntuneweave: { update_delay_ms: 8750 }\n";
    const selected = "tuneweave: { api_url: https://fixture.invalid/tune-path, request_timeout_ms: '22000' }\n";
    await writeFile(join(legacyDir, "global.yaml"), source);
    const selectedFile = join(secondDir, "global.yaml");
    await writeFile(selectedFile, selected);
    const file = join(dir, "config/global.yaml");
    const prior = "# 原配置\r\npermissions: { scopes: { tools.install: {policy: deny} } }\r\n";
    await writeFile(file, prior);
    const route = panelMediaEnvironment(root);
    const admin = panelApi(token, [], endpoint => endpoint === path ? route : undefined);
    expect((await admin(request("GET", undefined, false)))?.status).toBe(401);
    const raw = await (await admin(request()))!.text();
    for (const hidden of [toolsDir, binDir, "private-release", "tune-path", "test-repo", "fixture-command"]) {
      expect(raw).not.toContain(hidden);
    }
    const before = JSON.parse(raw);
    expect(before.settings).toEqual({ tool_timeout_ms: 300000, download_retries: 4, request_timeout_ms: 22000, update_delay_ms: 180000 });
    for (const patch of [{ api_url: "https://fixture.invalid/" }, { tools_path: "fixture" }, { ffmpeg: { command: "fixture" } },
      { update_delay_ms: 0 }, { update_delay_ms: "1000" }, { request_timeout_ms: 0 }, { tool_timeout_ms: 2_147_483_648 }, { download_retries: 1.5 }]) {
      expect((await admin(request("PUT", { patch, revision: before.revision })))?.status).toBe(400);
    }
    const patch = { tool_timeout_ms: 7500, download_retries: 2, request_timeout_ms: 15 };
    let revoke = true;
    expect((await route(request("PUT", { patch, revision: before.revision }), () => {
      const active = revoke;
      revoke = false;
      return active;
    })).status).toBe(401);
    expect(await readFile(file, "utf8")).toBe(prior);
    let changed = false;
    expect((await route(request("PUT", { patch, revision: before.revision }), () => {
      if (!changed) {
        changed = true;
        writeFileSync(selectedFile, selected.replace("tune-path", "new-tune-path"));
      }
      return true;
    })).status).toBe(409);
    expect(await readFile(file, "utf8")).toBe(prior);
    await writeFile(selectedFile, selected);
    const saved = (await admin(request("PUT", { patch, revision: before.revision })))!;
    expect(saved.status).toBe(200);
    const after = await saved.json();
    expect(after.settings).toEqual({ ...patch, update_delay_ms: before.settings.update_delay_ms });
    expect((await admin(request("PUT", { patch: { download_retries: 3 }, revision: before.revision })))?.status).toBe(409);
    expect(await readFile(join(legacyDir, "global.yaml"), "utf8")).toBe(source);
    expect(await readFile(selectedFile, "utf8")).toBe(selected);
    expect(await readFile(file, "utf8")).toStartWith(prior);
    const effective = await loadGlobalConfig(root);
    expect(effective.permissions.scopes["tools.install"]).toEqual({ policy: "deny" });
    expect(normalizeToolsConfig(effective.tools)).toMatchObject({ timeout_ms: 7500, download_retries: 2, dir: toolsDir, bin_dir: binDir,
      github_api: "https://fixture.invalid/private-release", ffmpeg: { command: "unique-nonexistent-fixture-command", repo: "fixture/test-repo" } });
    const attempts: number[] = [];
    const installer = new ToolInstallerService({ config: effective.tools, platform: "linux", arch: "x64",
      fetch: Object.assign(async () => { throw new Error("Offline fixture"); }, { preconnect() {} }), spawn: () => { throw new Error("No external program should run"); } });
    installer.fetchLatestRelease = async (repo, api) => {
      expect(repo).toBe("fixture/test-repo");
      expect(api).toBe("https://fixture.invalid/private-release");
      return { assets: [{ name: "ffmpeg-master-latest-linux64-gpl.tar.xz", browser_download_url: "https://fixture.invalid/ffmpeg" }] };
    };
    installer.downloadAsset = async (_url, _target, { timeoutMs } = {}) => {
      attempts.push(timeoutMs!);
      throw new Error("Offline install attempt fixture");
    };
    expect((await installer.ensureAll()).ok).toBe(false);
    expect(attempts).toEqual([7500, 7500]);
    const tuneweave = new TuneWeaveService({ config: effective.tuneweave, fetch: async (url, init) => {
      expect(String(url)).toBe("https://fixture.invalid/tune-path/healthz");
      const signal = init?.signal!;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("Offline request timed out");
    } });
    expect(tuneweave.config.request_timeout_ms).toBe(15);
    await expect(tuneweave.request("/healthz")).rejects.toMatchObject({ code: "tuneweave_unavailable" });
    expect((await admin(request("PUT", { patch: before.settings, revision: after.revision })))?.status).toBe(200);
    expect((await (await admin(request()))!.json()).settings).toEqual(before.settings);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("同时保存末尾 YAML 工具组和新增 TuneWeave 组；旧来源冲突不会给面板静默择址", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-panel-media-environment-yaml-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    await mkdir(join(dir, "config"));
    const file = join(dir, "config/global.yaml");
    const local = "tools:\n  bin_dir: fixture-tool-directory";
    await writeFile(file, local);
    const route = panelMediaEnvironment(root);
    const before = await (await route(request(), () => true)).json();
    const changed = await route(request("PUT", { patch: { tool_timeout_ms: 30, request_timeout_ms: 25 }, revision: before.revision }), () => true);
    expect(changed.status).toBe(200);
    const config = await loadGlobalConfig(root);
    expect(config.tools).toEqual({ bin_dir: "fixture-tool-directory", timeout_ms: 30 });
    expect(config.tuneweave).toEqual({ request_timeout_ms: 25 });
    await writeFile(file, local);
    for (const [plugin, host] of [["Lotus-Plugin", "one"], ["Lotus-ReFactor", "two"]]) {
      const directory = join(dir, `plugins/${plugin}/config`);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "global.yaml"), `tuneweave: { api_url: https://${host}.fixture.invalid }`);
    }
    expect((await route(request(), () => true)).status).toBe(500);
    expect((await route(request("PUT", { patch: { request_timeout_ms: 31 }, revision: before.revision }), () => true)).status).toBe(500);
    expect(await readFile(file, "utf8")).toBe(local);
    expect((await readLotusGlobalConfig(root)).tools).toEqual({ bin_dir: "fixture-tool-directory" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("面板只保存下次启动的首轮维护等待，保留已开始的维护与旧字符串配置", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-panel-media-startup-delay-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    const legacyDirectory = join(dir, "plugins/Lotus-Plugin/config");
    await mkdir(legacyDirectory, { recursive: true });
    await mkdir(join(dir, "config"));
    const legacy = "tuneweave: { api_url: https://fixture.invalid/unchanged, request_timeout_ms: 22000, update_delay_ms: ' 13500 ' }\n";
    const legacyFile = join(legacyDirectory, "global.yaml");
    await writeFile(legacyFile, legacy);
    const route = panelMediaEnvironment(root);
    const before = await (await route(request(), () => true)).json();
    expect(before.settings.update_delay_ms).toBe(13500);
    expect(JSON.stringify(before)).not.toContain("fixture.invalid");
    let resumed = 0;
    let prepared = 0;
    let releaseStartup: (() => void) | undefined;
    const waits: number[] = [];
    function start() {
      const reachedWait = Promise.withResolvers<void>();
      const runtime = startMediaMaintenance({ mediaRuntime: {
        disconnect: new AbortController().signal,
        whenReady(onReady) { releaseStartup = onReady; return () => { releaseStartup = undefined; }; },
      } }, {
        load: () => loadGlobalConfig(root),
        createTune() {
          return {
            localUrl: () => new URL("http://127.0.0.1:7832"),
            async resume() { resumed++; return { skipped: true }; },
            async initialize() { throw new Error("No TuneWeave connection in this fixture"); },
          };
        },
        async prepareTools() { prepared++; throw new Error("No install in this fixture"); },
        async wait(ms, signal) {
          waits.push(ms);
          reachedWait.resolve();
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
          signal.throwIfAborted();
        },
      });
      releaseStartup?.();
      return { dispose: () => runtime?.dispose(), reachedWait: reachedWait.promise };
    }
    const existing = start();
    await existing.reachedWait;
    expect(resumed).toBe(1);
    expect(waits).toEqual([13500]);
    for (const value of [-1, 2_147_483_648, 1.25]) {
      expect((await route(request("PUT", { patch: { update_delay_ms: value }, revision: before.revision }), () => true)).status).toBe(400);
    }
    const saved = await route(request("PUT", { patch: { update_delay_ms: 5800 }, revision: before.revision }), () => true);
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toEqual({ ...before.settings, update_delay_ms: 5800 });
    expect(waits).toEqual([13500]);
    expect(resumed).toBe(1);
    expect(prepared).toBe(0);
    await existing.dispose();
    const next = start();
    await next.reachedWait;
    expect(waits).toEqual([13500, 5800]);
    expect(resumed).toBe(2);
    expect(prepared).toBe(0);
    await next.dispose();
    expect(await readFile(legacyFile, "utf8")).toBe(legacy);
    expect((await loadGlobalConfig(root)).tuneweave).toEqual({ api_url: "https://fixture.invalid/unchanged", request_timeout_ms: 22000, update_delay_ms: 5800 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
