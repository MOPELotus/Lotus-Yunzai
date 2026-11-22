import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelRuntimeSettings } from "../lib/panel-runtime-settings.ts";

test("宿主运行设置沿用旧生效配置，忽略不相关字段并防止过期覆盖", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-runtime-"));
  const root = pathToFileURL(directory + "/");
  const endpoint = "http://localhost/panel/api/settings/native/runtime";
  const handle = panelRuntimeSettings(root);
  const get = async () => (await handle(new Request(endpoint), () => true)).json();
  const put = (previous: unknown, values: unknown, authorized = () => true) => handle(new Request(endpoint, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previous, values }),
  }), authorized);
  try {
    await mkdir(join(directory, "config/config"), { recursive: true });
    const legacy = join(directory, "config/config/bot.yaml");
    const modern = join(directory, "config/bot.yaml");
    const legacySource = "# 旧配置\nlog_level: WARN\nlog_object: {depth: 4, length: '90'}\nlog_align: Host\nplugin_load_timeout: '2.75'\ncache_group_member: 0\nmsg_type_count: '1'\npanel_token: fixture\n";
    await writeFile(legacy, legacySource);
    const initial = await get();
    expect(initial.fields).toHaveLength(11);
    expect(initial.values).toEqual({
      imageRenderPreset: "standard", log_level: "warn", log_length: 10_000, "/→#": true,
      log_object: { depth: 4, length: 90 }, log_align: "Host", plugin_load_timeout: 2.75,
      cache_group_member: false, msg_type_count: true, file_watch: true, online_msg_exp: 1440,
    });
    expect(JSON.stringify(initial)).not.toContain("fixture");
    const changes = { ...initial.values, imageRenderPreset: "low", "/→#": false, online_msg_exp: 0,
      log_object: false, log_align: "", plugin_load_timeout: 0.35 };
    expect((await put(initial.values, { ...changes, log_length: 32_001 })).status).toBe(400);
    expect((await put(initial.values, { ...changes, log_object: { depth: 11 } })).status).toBe(400);
    expect((await put(initial.values, { ...changes, plugin_load_timeout: -1 })).status).toBe(400);
    expect((await put(initial.values, { ...changes, panel_token: "" })).status).toBe(400);
    let checks = 0;
    expect((await put(initial.values, changes, () => ++checks === 1)).status).toBe(401);
    expect(await readFile(legacy, "utf8")).toBe(legacySource);
    expect((await put(initial.values, changes)).status).toBe(200);
    expect(await Bun.file(modern).exists()).toBe(false);
    expect((await readFile(legacy, "utf8"))).toContain("# 旧配置");
    expect(Bun.YAML.parse(await readFile(legacy, "utf8"))).toMatchObject({
      log_level: "WARN", cache_group_member: 0, panel_token: "fixture", "/→#": false,
      imageRenderPreset: "low", online_msg_exp: 0,
      log_object: false, log_align: "", plugin_load_timeout: 0.35,
    });
    expect((await get()).values).toEqual(changes);
    expect((await put(initial.values, changes)).status).toBe(409);

    await writeFile(modern, "log_level: debug\n");
    const current = (await get()).values;
    expect(current).toMatchObject({ log_level: "debug", "/→#": false, imageRenderPreset: "standard" });
    expect((await put(current, { ...current, cache_group_member: false })).status).toBe(200);
    expect(Bun.YAML.parse(await readFile(modern, "utf8"))).toEqual({ log_level: "debug", cache_group_member: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
