import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelMusic } from "../lib/panel-music.ts";
import { panelApi } from "../lib/panel.ts";
import { loadGlobalConfig } from "../plugins/media/core/config/global.ts";
import { MusicService, type MusicConfig } from "../plugins/media/services/music/service.ts";

const path = "/panel/api/settings/media/music";
const token = "music-panel-fixture";
function request(method = "GET", data?: unknown, authenticated = true) {
  return new Request(`http://localhost${path}`, {
    method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

test("点歌设置只返回七项字段，在事务内校验授权并写入点歌当前有效配置", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-panel-music-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    const legacyDir = join(dir, "plugins/Lotus-Plugin/config");
    await mkdir(legacyDir, { recursive: true });
    await mkdir(join(dir, "plugins/Lotus-ReFactor/config"), { recursive: true });
    await mkdir(join(dir, "config"));
    const inherited = "music: { default_platform: qq, search_limit: '20', unexposed: test-source-private }\n";
    await writeFile(join(legacyDir, "global.yaml"), inherited);
    await writeFile(join(dir, "plugins/Lotus-ReFactor/config/global.yaml"), "music: { default_platform: migu, search_limit: 19 }\n");
    const file = join(dir, "config/global.yaml");
    const prior = "# 保留原配置\r\ntuneweave: { api_url: https://fixture.invalid, private_key: test-tuneweave-secret }\r\n";
    await writeFile(file, prior);
    const route = panelMusic(root);
    const panel = panelApi(token, [], target => target === path ? route : undefined);
    expect((await panel(request("GET", undefined, false)))?.status).toBe(401);
    const beforeText = await (await panel(request()))!.text();
    expect(beforeText).not.toContain("test-source-private");
    expect(beforeText).not.toContain("test-tuneweave-secret");
    const before = JSON.parse(beforeText);
    expect(before.settings).toEqual({ enable: true, default_platform: "qq", quality: "standard", search_limit: 20,
      session_timeout_ms: 120000, download_timeout_ms: 180000, max_size_mb: 128 });
    for (const patch of [{ quality: "unknown" }, { search_limit: 31 }, { download_timeout_ms: 0 },
      { session_timeout_ms: "2000" }, { max_size_mb: 1.25 }, { token: "unused" }]) {
      expect((await panel(request("PUT", { patch, revision: before.revision })))?.status).toBe(400);
    }
    let active = true;
    const patch = { default_platform: "migu", quality: "hires", search_limit: 7, session_timeout_ms: 60000,
      download_timeout_ms: 9000, max_size_mb: 64 };
    expect((await route(request("PUT", { patch, revision: before.revision }), () => {
      const allowed = active;
      active = false;
      return allowed;
    })).status).toBe(401);
    expect(await readFile(file, "utf8")).toBe(prior);
    const saved = (await panel(request("PUT", { patch, revision: before.revision })))!;
    expect(saved.status).toBe(200);
    const after = await saved.json();
    expect((await panel(request("PUT", { patch: { search_limit: 8 }, revision: before.revision })))?.status).toBe(409);
    const config = await loadGlobalConfig(root);
    expect(config.music).toEqual({ ...patch, unexposed: "test-source-private" });
    expect(await readFile(file, "utf8")).toStartWith(prior);
    expect(await readFile(join(legacyDir, "global.yaml"), "utf8")).toBe(inherited);
    const seen: URL[] = [];
    const service = new MusicService({ config: config.music as Partial<MusicConfig>, accountsFile: join(dir, "music-accounts.json"),
      tuneweaveConfig: { api_url: "https://fixture.invalid" }, fetch: async () => { throw new Error("No outward network"); } });
    service.tuneweave.request = (async (address: string) => {
      const url = new URL(address, "https://fixture.invalid");
      seen.push(url);
      return url.pathname === "/v1/search" ? { data: [], accountSelected: false } : { url: "/fixture.audio" };
    }) as typeof service.tuneweave.request;
    await service.search(String(config.music.default_platform), "fixture", 2);
    await service.resolve({ platform: "migu", ref: "fixture", name: "fixture", id: "1" });
    expect(Object.fromEntries(seen[0]!.searchParams)).toMatchObject({ platform: "migu", limit: "7", offset: "7" });
    expect(seen[1]!.searchParams.get("quality")).toBe("hires");
    expect(service.config.download_timeout_ms).toBe(9000);
    expect(service.config.max_size_mb).toBe(64);
    expect((await panel(request("PUT", { patch: before.settings, revision: after.revision })))?.status).toBe(200);
    expect((await (await panel(request()))!.json()).settings).toEqual(before.settings);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("点歌只覆盖当前音乐设置，保留他处的 YAML 共享设置", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-panel-music-yaml-"));
  try {
    const root = pathToFileURL(`${dir}/`);
    await mkdir(join(dir, "config"));
    const file = join(dir, "config/global.yaml");
    await writeFile(file, '# 原装配置\nshared: &shared { enable: true, quality: standard, search_limit: "18" }\nmusic: *shared # 音乐\n');
    const route = panelMusic(root);
    const before = await (await route(request(), () => true)).json();
    expect((await route(request("PUT", { patch: { quality: "lossless", enable: false }, revision: before.revision }), () => true)).status).toBe(200);
    const source = await readFile(file, "utf8");
    expect(source).toContain('shared: &shared { enable: true, quality: standard, search_limit: "18" }');
    expect(source).toContain("music: {<<: *shared,");
    expect(source).toContain("# 音乐");
    const config = await loadGlobalConfig(root);
    expect(config.music).toEqual({ enable: false, quality: "lossless", search_limit: "18" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
