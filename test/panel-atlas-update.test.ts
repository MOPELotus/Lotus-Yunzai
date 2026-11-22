import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { panelApi } from "../lib/panel.ts";
import { panelAtlasUpdate } from "../lib/panel-atlas-update.ts";
import { HandlerScope } from "../lib/plugins/handler.ts";
import { LegacyTasks } from "../lib/plugins/tasks.ts";
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
      enable: true, check_cron: "0 0 */6 * * ? *", challenge_cron: "0 15 */2 * * ? *", run_on_missing_data: false,
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
    const response = await handler(request("PUT", { ...before, settings: { ...before.settings, enable: true } }), () => true);
    expect(response.status).toBe(200);
    expect(await readFile(file, "utf8")).toContain("  auto_update: {<<: *shared, enable: true} # 原共享");
    const config = await readLotusGlobalConfig(root);
    expect(config.config).toEqual({ enable: false, check_cron: "18 8 * * *", unsupported: "retained" });
    expect(config.atlas).toEqual({ version_channel: "live", auto_update: { ...config.config as object, enable: true } });
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
      route(request("PUT", { ...snapshot, settings: { ...snapshot.settings, run_on_missing_data } }), () => true);
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
