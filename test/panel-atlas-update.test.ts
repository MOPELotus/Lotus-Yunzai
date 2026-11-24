import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { panelApi } from "../lib/panel.ts";
import { panelAtlasUpdate } from "../lib/panel-atlas-update.ts";
import { HandlerScope } from "../lib/plugins/handler.ts";
import { LegacyTasks } from "../lib/plugins/tasks.ts";
import { createModule } from "../plugins/atlas/index.ts";
import { createAtlasMaintenance } from "../plugins/atlas/maintenance.ts";

const endpoint = "/panel/api/settings/atlas/update";
const token = "atlas-panel-fixture";
function request(method = "GET", body?: unknown, authenticated = true) {
  return new Request(`http://localhost${endpoint}`, {
    method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function validTask(cron: string) {
  try {
    const task = new LegacyTasks().prepare([{ owner: new HandlerScope(), app: { name: "Atlas fixture", task: { cron, fnc() {} } } }]);
    task.cancel();
    return true;
  } catch { return false; }
}

test("图鉴面板写入现有 Atlas 调度配置，版本来源、旧字段与外部改动得到保留", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-panel-"));
  try {
    const root = pathToFileURL(directory + "/");
    const legacyDir = join(directory, "plugins/Lotus-Plugin/config");
    await mkdir(legacyDir, { recursive: true });
    await mkdir(join(directory, "config"));
    const original = "atlas:\n  version_channel: latest\n  data_root: private-atlas-path\n" +
      "  auto_update: { enable: true, run_on_missing_data: false }\n";
    await writeFile(join(legacyDir, "global.yaml"), original);
    const file = join(directory, "config/global.yaml");
    const unrelated = "# 保留 CRLF 与注释\r\ncoin_shop: { enable: false }\r\n";
    await writeFile(file, unrelated);
    const route = panelAtlasUpdate(root, validTask);
    const admin = panelApi(token, [], path => path === endpoint ? route : undefined);
    expect((await admin(request("GET", undefined, false)))?.status).toBe(401);
    const beforeResponse = (await admin(request()))!;
    const raw = await beforeResponse.text();
    expect(raw).not.toContain("private-atlas-path");
    const before = JSON.parse(raw);
    expect(before.settings).toEqual({
      enable: true, check_cron: "0 30 1,13 * * ? *", challenge_cron: "0 30 1,13 * * ? *", run_on_missing_data: false,
    });
    const edited = { ...before.settings, check_cron: "13 8 * * MON-FRI", challenge_cron: "0 14 */3 * * ? *" };
    const invalid = await admin(request("PUT", { revision: before.revision, settings: { ...edited, challenge_cron: "0 0 9 ? * 1-5 *" } }));
    expect(invalid?.status).toBe(400);
    expect(await invalid?.json()).toEqual({ field: "challenge_cron" });
    expect((await admin(request("PUT", { revision: before.revision, settings: { ...edited, update_command: "fixture" } })))?.status).toBe(400);
    expect(await readFile(file, "utf8")).toBe(unrelated);
    let active = true;
    expect((await route(request("PUT", { revision: before.revision, settings: edited }), () => {
      const allowed = active;
      active = false;
      return allowed;
    })).status).toBe(401);
    expect(await readFile(file, "utf8")).toBe(unrelated);
    const saved = (await admin(request("PUT", { revision: before.revision, settings: edited })))!;
    expect(saved.status).toBe(200);
    const after = await saved.json();
    expect(after.settings).toEqual(edited);
    expect(await readFile(file, "utf8")).toStartWith(unrelated);
    expect(await readFile(join(legacyDir, "global.yaml"), "utf8")).toBe(original);
    const effective = (await readLotusGlobalConfig(root)).atlas;
    expect(effective).toMatchObject({ data_root: "private-atlas-path", version_channel: "latest",
      auto_update: { run_on_missing_data: false, ...edited } });
    const runtime = createAtlasMaintenance(directory, { updateConfig: effective,
      async manifest() { throw new Error("fixture runs without upstream network"); } }).atlasSchedule;
    expect(runtime.version.cron).toBe("0 13 8 * * MON-FRI");
    expect(runtime.challenge.cron).toBe("0 14 */3 * * *");
    expect(validTask(runtime.version.cron!)).toBe(true);
    expect(validTask(runtime.challenge.cron!)).toBe(true);
    expect((await admin(request("PUT", { revision: before.revision, settings: before.settings })))?.status).toBe(409);
    const reset = (await admin(request("PUT", { revision: after.revision, settings: { enable: false, check_cron: "", challenge_cron: "" } })))!;
    expect((await reset.json()).settings).toEqual({ ...before.settings, enable: false });
    const disabled = createAtlasMaintenance(directory, { updateConfig: (await readLotusGlobalConfig(root)).atlas }).atlasSchedule;
    expect(disabled.version.cron).toBeUndefined();
    expect(await disabled.challenge.run()).toBe("图鉴自动更新未启用。");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("编辑图鉴定时配置保留 YAML 锚、共享源和原有版路选择", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-panel-yaml-"));
  try {
    const root = pathToFileURL(directory + "/");
    await mkdir(join(directory, "config"));
    const file = join(directory, "config/global.yaml");
    const source = "config: &shared { enable: false, check_cron: '18 8 * * *', unsupported: retained }\n" +
      "atlas:\n  version_channel: live # 原选择\n  auto_update: *shared # 原共享\n";
    await writeFile(file, source);
    const handler = panelAtlasUpdate(root, validTask);
    const before = await (await handler(request(), () => true)).json();
    const response = await handler(request("PUT", { revision: before.revision, settings: { ...before.settings, enable: true } }), () => true);
    expect(response.status).toBe(200);
    expect(await readFile(file, "utf8")).toContain("  auto_update: {<<: *shared, enable: true} # 原共享");
    const config = await readLotusGlobalConfig(root);
    expect(config.config).toEqual({ enable: false, check_cron: "18 8 * * *", unsupported: "retained" });
    expect(config.atlas).toEqual({ version_channel: "live", auto_update: { ...config.config as object, enable: true } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("图鉴搜索上限可保存并回读，独立于定时任务并拒绝过期写入", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-search-limit-"));
  try {
    const root = pathToFileURL(directory + "/");
    const config = join(directory, "config");
    await mkdir(config);
    const file = join(config, "global.yaml");
    const source = "atlas:\r\n  version_channel: live\r\n  max_results: '3' # 模糊匹配\r\n  auto_update: { enable: false }\r\n";
    await writeFile(file, source);
    const route = panelAtlasUpdate(root, validTask);
    const get = async () => (await route(request(), () => true)).json();
    const before = await get();
    const put = (searchLimit: unknown) => route(request("PUT", { settings: before.settings,
      revision: before.revision, searchLimit }), () => true);
    expect(before.searchLimit).toBe(3);
    for (const value of [0, 1.5, 2 ** 53, "2", null]) {
      const response = await put(value);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ field: "searchLimit" });
    }
    expect(await readFile(file, "utf8")).toBe(source);
    const applied = await put(60);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ searchLimit: 60, settings: before.settings });
    expect(await get()).toMatchObject({ searchLimit: 60 });
    expect(await readFile(file, "utf8")).toBe(source.replace("'3'", "60"));
    expect((await put(7)).status).toBe(409);
    expect((await readLotusGlobalConfig(root)).atlas).toMatchObject({ max_results: 60, version_channel: "live", auto_update: { enable: false } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("图鉴语言读取旧目录名，保存独立语言并拒绝无效值及过期写入", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-panel-locale-"));
  try {
    const root = pathToFileURL(directory + "/");
    const config = join(directory, "config");
    await mkdir(config);
    const file = join(config, "global.yaml");
    const source = "atlas:\n  locale: 日本語 # 旧目录名\n  version_channel: latest\n  auto_update: { enable: false }\n";
    await writeFile(file, source);
    const route = panelAtlasUpdate(root, validTask);
    const before = await (await route(request(), () => true)).json();
    expect(before.locale).toBe("ja");
    const put = (locale: unknown) => route(request("PUT", { settings: before.settings, revision: before.revision, locale }), () => true);
    const invalid = await put("../English");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ field: "locale" });
    expect(await readFile(file, "utf8")).toBe(source);
    const changed = await put("ko");
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ locale: "ko", settings: before.settings });
    expect(await readFile(file, "utf8")).toBe(source.replace("日本語", '"ko"'));
    expect((await put("en")).status).toBe(409);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("图鉴同步默认发布，页面关闭后只修改候选发布配置", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-panel-prepare-"));
  try {
    const root = pathToFileURL(directory + "/");
    await mkdir(join(directory, "config"));
    const file = join(directory, "config/global.yaml");
    const original = "# preserve\natlas: { version_channel: live, auto_update: { enable: false } }\n";
    await writeFile(file, original);
    const route = panelAtlasUpdate(root, validTask);
    const get = async () => (await route(request(), () => true)).json();
    const before = await get();
    expect(before.syncAfterUpdate).toBeTrue();
    expect(before.syncGallery).toBeTrue();
    const put = (syncAfterUpdate: unknown) => route(request("PUT", { settings: before.settings,
      revision: before.revision, syncAfterUpdate }), () => true);
    const invalid = await put("false");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ field: "syncAfterUpdate" });
    expect(await readFile(file, "utf8")).toBe(original);
    const saved = await put(false);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ syncAfterUpdate: false, settings: before.settings });
    expect((await get()).syncAfterUpdate).toBeFalse();
    expect((await readLotusGlobalConfig(root)).atlas).toEqual({ version_channel: "live", sync_after_update: false, auto_update: { enable: false } });
    expect((await put(true)).status).toBe(409);
    const after = await get();
    const gallery = (syncGallery: unknown) => route(request("PUT", { settings: after.settings,
      revision: after.revision, syncGallery }), () => true);
    expect((await gallery("false")).status).toBe(400);
    expect(await (await gallery(false)).json()).toMatchObject({ syncGallery: false, syncAfterUpdate: false });
    expect((await readLotusGlobalConfig(root)).atlas).toMatchObject({ sync_gallery: false, sync_after_update: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("三游角色图库开关默认开启，和图鉴插图分开保存及检查并发", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-character-gallery-panel-"));
  try {
    const root = pathToFileURL(directory + "/");
    await mkdir(join(directory, "config"));
    const file = join(directory, "config/global.yaml");
    const original = "# 保留注释与既有图鉴插图开关\r\natlas:\r\n  sync_gallery: false\r\n  auto_update: {enable: false}\r\n";
    await writeFile(file, original);
    const route = panelAtlasUpdate(root, validTask);
    const admin = panelApi(token, [], path => path === endpoint ? route : undefined);
    const get = async () => (await admin(request()))!.json();
    const initial = await get();
    expect(initial).toMatchObject({ syncCharacterGallery: true, syncGallery: false, settings: { enable: false } });
    const edit = (value: unknown, revision = initial.revision) => request("PUT", {
      revision, settings: initial.settings, syncCharacterGallery: value,
    });
    const invalid = await admin(edit("false"));
    expect(invalid?.status).toBe(400);
    expect(await invalid?.json()).toEqual({ field: "syncCharacterGallery" });
    let authorize = true;
    expect((await route(edit(false), () => {
      const current = authorize;
      authorize = false;
      return current;
    })).status).toBe(401);
    expect(await readFile(file, "utf8")).toBe(original);

    const saved = await admin(edit(false));
    expect(saved?.status).toBe(200);
    const disabled = await saved!.json();
    expect(disabled).toMatchObject({ syncCharacterGallery: false, syncGallery: false, settings: initial.settings });
    expect(await get()).toEqual(disabled);
    expect(disabled.revision).not.toBe(initial.revision);
    expect((await admin(edit(true)))?.status).toBe(409);
    expect(await readFile(file, "utf8")).toBe(original + "  sync_character_gallery: false\r\n");

    expect((await admin(edit(true, disabled.revision)))?.status).toBe(200);
    expect(await get()).toMatchObject({ syncCharacterGallery: true, syncGallery: false, settings: initial.settings });
    const effective = (await readLotusGlobalConfig(root)).atlas;
    expect(effective).toMatchObject({ sync_character_gallery: true, sync_gallery: false, auto_update: { enable: false } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("缺数据开关仅在重启后的版本任务读取，并保持原版本渠道和两条 Cron", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-panel-empty-"));
  try {
    const root = pathToFileURL(directory + "/");
    await mkdir(join(directory, "config"));
    const file = join(directory, "config/global.yaml");
    const unrelated = "# 保留 CRLF 和原值\r\ncoin_shop: { enable: false }\r\n";
    await writeFile(file, unrelated);
    const route = panelAtlasUpdate(root, validTask);
    const get = async () => (await route(request(), () => true)).json();
    const put = (snapshot: { revision: string; settings: Record<string, unknown> }, run_on_missing_data: unknown) =>
      route(request("PUT", { revision: snapshot.revision, settings: { ...snapshot.settings, run_on_missing_data } }), () => true);
    const initial = await get();
    expect(initial.settings.run_on_missing_data).toBe(true);
    expect(initial.settings.enable).toBe(false);
    expect((await put(initial, "false")).status).toBe(400);
    expect((await put(initial, false)).status).toBe(200);
    expect(await get()).toMatchObject({ settings: { enable: false, run_on_missing_data: false } });
    expect(await readFile(file, "utf8")).toStartWith(unrelated);
    expect((await readLotusGlobalConfig(root)).atlas).toEqual({ auto_update: { enable: false, run_on_missing_data: false } });

    const original = unrelated + "atlas:\r\n  version_channel: live # 原版本\r\n" +
      "  auto_update: {check_cron: ' 4 5 * * * ', challenge_cron: '', run_on_missing_data: false}\r\n";
    await writeFile(file, original);
    let checks = 0;
    const data = join(directory, "data/atlas");
    const runtime = async () => createAtlasMaintenance(data, {
      updateConfig: (await readLotusGlobalConfig(root)).atlas,
      async manifest() { checks++; return {}; },
    }).atlasSchedule;
    const running = await runtime();
    const before = await get();
    const saved = await put(before, true);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual(await get());
    expect(await readFile(file, "utf8")).toBe(original.replace("run_on_missing_data: false", "run_on_missing_data: true"));
    expect(await Bun.file(join(data, "current/map.json")).exists()).toBeFalse();
    expect(checks).toBe(0);
    expect((await put(before, false)).status).toBe(409);
    expect(await running.version.run()).toContain("未初始化");
    expect(checks).toBe(0);
    const reloaded = await runtime();
    expect(reloaded.version.cron).toBe("0 4 5 * * *");
    expect(reloaded.challenge.cron).toBeUndefined();
    await reloaded.version.run();
    expect(checks).toBe(1);
    expect(await Bun.file(join(data, "current/map.json")).exists()).toBeFalse();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("编辑两组旧图鉴范围后重建任务，实际仅读取所选分类", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-panel-scopes-"));
  try {
    const root = pathToFileURL(directory + "/");
    await mkdir(join(directory, "config"));
    const file = join(directory, "config/global.yaml");
    const before = "# 保留原值\r\natlas:\r\n  version_channel: live # 原版路\r\n" +
      "  update_args: ['src/scrape.mjs', '--mode', 'incremental', '--game=gi', '--page', 'gi=weapon'] # 保留行尾备注\r\n" +
      "  challenge_args:\r\n    - --page\r\n    - gi=tower\r\n" +
      "  auto_update: {enable: true, run_on_missing_data: false, check_cron: '10 4 * * *'}\r\n";
    await writeFile(file, before);
    const handler = panelAtlasUpdate(root, validTask);
    const panel = panelApi(token, [], path => path === endpoint ? handler : undefined);
    const read = async () => (await panel(request()))!.json();
    const initial = await read();
    expect(initial.scopes.update_args.selected).toEqual(["gi/weapon"]);
    expect(initial.scopes.challenge_args.selected).toEqual(["gi/tower"]);
    const put = (scopePatch: unknown, previous = initial, authenticated = true) =>
      panel(request("PUT", { revision: previous.revision, settings: previous.settings, scopePatch }, authenticated));
    expect((await put({ update_args: ["gi/weapon"], challenge_args: ["gi/tower"] }))?.status).toBe(200);
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await put({ update_args: ["hsr/lightcone"] }, initial, false))?.status).toBe(401);
    expect((await put({ update_args: [] }))?.status).toBe(400);
    expect((await put({ challenge_args: ["hsr/lightcone"] }))?.status).toBe(422);
    expect((await put({ update_args: ["--page=gi=weapon"] }))?.status).toBe(422);

    const dataRoot = join(directory, "data/atlas");
    const data = join(dataRoot, "snapshots/1/data");
    await mkdir(join(data, "items"), { recursive: true });
    await symlink("snapshots/1/data", join(dataRoot, "current"));
    const games = { gi: { locales: { zh: { pages: {} as Record<string, unknown> } } },
      hsr: { locales: { zh: { pages: {} as Record<string, unknown> } } },
      zzz: { locales: { zh: { pages: {} as Record<string, unknown> } } } };
    const cases = [["gi", "weapon"], ["gi", "tower"], ["hsr", "lightcone"], ["zzz", "shiyu"]] as const;
    const row = { zh: "同版资料", begin: "2026-11-01", end: "2026-12-01" };
    for (const [game, page] of cases) {
      const path = `items/${game}-${page}.json`;
      const entry = { id: "1", name: row.zh, path, hasDetail: false };
      games[game].locales.zh.pages[page] = { id: page, version: "7.2", sampled: false, recordCount: 1,
        totalRecordCount: 1, records: { "1": entry } };
      await writeFile(join(data, path), JSON.stringify({
        meta: { gameId: game, pageId: page, version: "7.2", locale: "zh", recordId: "1", name: row.zh, hasDetail: false },
        content: { list: row, detail: null },
      }));
    }
    await writeFile(join(data, "map.json"), JSON.stringify({ games }));
    const release = { live: "7.2", latest: "7.2", available: ["7.2"] };
    const calls: string[] = [];
    const schedule = async () => createAtlasMaintenance(dataRoot, {
      updateConfig: (await readLotusGlobalConfig(root)).atlas,
      manifest: async () => ({ gi: release, hsr: release, zzz: release }),
      async request(url) { calls.push(new URL(url).pathname); return Response.json({ "1": row }); },
    }).atlasSchedule;
    const old = await schedule();
    const result = (await put({ update_args: ["hsr/lightcone"], challenge_args: ["zzz/shiyu"] }))!;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(await read());
    expect(await readFile(file, "utf8")).toBe(before
      .replace("['src/scrape.mjs', '--mode', 'incremental', '--game=gi', '--page', 'gi=weapon']", '["--pages","hsr=lightcone"]')
      .replace("- --page\r\n    - gi=tower\r\n", '["--pages","zzz=shiyu"]\r\n'));
    expect((await put({ challenge_args: ["gi/tower"] }))?.status).toBe(409);
    expect(calls).toEqual([]);
    expect(await old.version.run()).toContain("gi 7.2");
    expect(await old.challenge.run()).toContain("来源索引与现用资料一致");
    expect(calls).toEqual(["/gi/7.2/tower.json"]);
    calls.length = 0;
    const reloaded = await schedule();
    expect(reloaded.version.cron).toBe(old.version.cron);
    expect(reloaded.challenge.cron).toBe(old.challenge.cron);
    expect(await reloaded.version.run()).toContain("hsr 7.2");
    expect(await reloaded.challenge.run()).toContain("来源索引与现用资料一致");
    expect(calls).toEqual(["/zzz/7.2/shiyu.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("网页拒绝覆盖未知或无法往返的旧参数，并让未编辑值保持原样", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-panel-unrepresentable-"));
  try {
    const root = pathToFileURL(directory + "/");
    await mkdir(join(directory, "config"));
    const file = join(directory, "config/global.yaml");
    const before = "atlas:\n  version_channel: live\n  update_args: ['--page', 'gi=weapon,unknown'] # 无损保留\n" +
      "  challenge_args:\n    - --page\n    - gi=tower # 字段条目附有注释\n  auto_update: {enable: false}\n";
    await writeFile(file, before);
    const route = panelAtlasUpdate(root, validTask);
    const original = await (await route(request(), () => true)).json();
    expect(original.scopes.update_args.selected).toBeNull();
    expect(original.scopes.challenge_args.selected).toEqual(["gi/tower"]);
    for (const scopePatch of [{ update_args: ["gi/weapon"] }, { challenge_args: ["zzz/shiyu"] }]) {
      const response = await route(request("PUT", { revision: original.revision, settings: original.settings, scopePatch }), () => true);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ field: Object.keys(scopePatch)[0] });
    }
    expect(await readFile(file, "utf8")).toBe(before);
    const response = await route(request("PUT", { revision: original.revision,
      settings: { ...original.settings, run_on_missing_data: false } }), () => true);
    expect(response.status).toBe(200);
    expect(await readFile(file, "utf8")).toBe(before.replace("{enable: false}", "{run_on_missing_data: false, enable: false}"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("角色开关由图鉴面板保存并在重启后分开影响原铁命令", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-role-panel-"));
  const previous = Bun.env.LOTUS_ATLAS_DATA_DIR;
  try {
    const root = pathToFileURL(directory + "/");
    const data = join(directory, "data");
    await mkdir(data, { recursive: true });
    const entries = [
      ["gi", "character", "10000089", "芙宁娜"], ["hsr", "character", "1005", "卡芙卡"],
      ["zzz", "character", "1191", "艾莲"], ["gi", "weapon", "11501", "风鹰剑"],
    ] as const;
    const games: Record<string, { locales: { zh: { pages: Record<string, unknown> } } }> = {};
    for (const [game, page, id, name] of entries) {
      const path = `items/${game}-${page}-${id}.json`;
      const target = (games[game] ??= { locales: { zh: { pages: {} } } }).locales.zh.pages;
      target[page] = { id: page, version: "1.0", recordCount: 1, recorded: true, records: { [id]: { id, path, name, hasDetail: false } } };
      await mkdir(join(data, "items"), { recursive: true });
      await writeFile(join(data, path), JSON.stringify({ meta: { gameId: game, pageId: page, locale: "zh", recordId: id, name,
        version: "1.0", hasDetail: false }, content: { list: {}, detail: null } }));
    }
    await writeFile(join(data, "map.json"), JSON.stringify({ games }));
    Bun.env.LOTUS_ATLAS_DATA_DIR = data;
    const route = panelAtlasUpdate(root, validTask);
    const admin = panelApi(token, [], path => path === endpoint ? route : undefined);
    const before = await (await admin(request()))?.json();
    expect(before.roleQueries).toEqual({ role_wiki: true, role_talent: true, role_photo: true, role_q_face: true });
    expect(before.settings.enable).toBe(false);
    const old = createModule();
    const run = async (module: ReturnType<typeof createModule>, msg: string) => {
      const replies: unknown[] = [];
      const handled = await module.nativeEvents[0]!.rule.run({ msg, reply(value) { replies.push(value); } });
      return { handled, replies };
    };
    for (const cmd of ["#芙宁娜资料", "#芙宁娜天赋", "#芙宁娜命座", "*卡芙卡行迹", "*卡芙卡星魂", "#芙宁娜照片"]) {
      expect(await run(old, cmd)).toMatchObject({ handled: true });
    }
    const put = (roleQueries: Record<string, unknown>, revision = before.revision, valid = true) =>
      admin(request("PUT", { revision, settings: before.settings, roleQueries }, valid));
    expect((await put({ role_wiki: false }, before.revision, false))?.status).toBe(401);
    expect((await put({ role_wiki: "false" }))?.status).toBe(400);
    expect((await put({ role_q_face: "false" }))?.status).toBe(400);
    expect((await put({ charPicSe: true }))?.status).toBe(400);

    const overview = (await put({ role_wiki: false, role_q_face: false }))!;
    expect(overview.status).toBe(200);
    const first = await overview.json();
    expect(first.settings.enable).toBe(false);
    expect(first.roleQueries).toEqual({ role_wiki: false, role_talent: true, role_photo: true, role_q_face: false });
    expect((await put({ role_talent: false }))?.status).toBe(409);
    const restart = async () => createModule({ atlasUpdateConfig: (await readLotusGlobalConfig(root)).atlas });
    const one = await restart();
    expect(await run(one, "#芙宁娜资料")).toEqual({ handled: false, replies: [] });
    expect(await run(one, "#芙宁娜图鉴")).toEqual({ handled: false, replies: [] });
    expect(await run(one, "#芙宁娜天赋")).toMatchObject({ handled: true });
    expect(await run(one, "#芙宁娜照片")).toMatchObject({ handled: true });
    expect(await one.commands["#图鉴"]("原神 芙宁娜")).toContain("已关闭");
    expect(await one.commands["#角色图鉴"]("绝区零 艾莲")).toContain("艾莲");

    const other = (await put({ role_talent: false, role_photo: false, role_wiki: true }, first.revision))!;
    expect(other.status).toBe(200);
    expect((await other.json()).roleQueries.role_q_face).toBe(false);
    const two = await restart();
    expect(await run(two, "#芙宁娜资料")).toMatchObject({ handled: true });
    for (const cmd of ["#芙宁娜天赋", "#芙宁娜技能", "#芙宁娜命座", "*卡芙卡行迹", "*卡芙卡星魂", "#芙宁娜照片", "*卡芙卡写真"]) {
      expect(await run(two, cmd)).toEqual({ handled: false, replies: [] });
    }
    expect(await two.commands["#武器图鉴"]("原神 风鹰剑")).toContain("风鹰剑");
  } finally {
    if (previous === undefined) delete Bun.env.LOTUS_ATLAS_DATA_DIR;
    else Bun.env.LOTUS_ATLAS_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
