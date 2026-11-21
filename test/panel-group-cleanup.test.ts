import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createProfileStore } from "@lotus-yunzai/account";
import { groupCleanupCommands } from "../lib/group-cleanup-commands.ts";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { panelGroupCleanup } from "../lib/panel-group-cleanup.ts";
import { panelApi } from "../lib/panel.ts";

const url = "http://localhost/panel/api/settings/group/cleanup";
const token = "group-cleanup-settings-fixture";
function request(method = "GET", body?: unknown, authenticated = true) {
  return new Request(url, { method,
    headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("退群清理面板仅写两个选项，现有命令在下一次操作时按原权限和核验读取", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-group-cleanup-"));
  try {
    const root = pathToFileURL(`${directory}/`);
    const legacyDirectory = join(directory, "plugins/Lotus-Plugin/config");
    await mkdir(legacyDirectory, { recursive: true });
    await mkdir(join(directory, "config"));
    const legacy = join(legacyDirectory, "global.yaml");
    const source = "groups: {cleanup: {enable: false, keep_if_private_possible: false}}\n";
    await writeFile(legacy, source);
    const config = join(directory, "config/global.yaml");
    const beforeFile = "# 无关配置\r\npermissions: {scopes: {group.cleanup: {policy: master_only}}}\r\n";
    await writeFile(config, beforeFile);
    const profilesDirectory = join(directory, "profiles");
    await mkdir(profilesDirectory);
    const profileFile = join(profilesDirectory, "123.yaml");
    const originalProfile = Bun.YAML.stringify({ user: { qq: "123" }, profile: { id: 1, notify: { fallback_groups: [601, 602] } } });
    await writeFile(profileFile, originalProfile);
    const auditPath = join(directory, "cleanup-audit.jsonl");
    const route = panelGroupCleanup(root);
    const panel = panelApi(token, [], () => route);
    expect((await panel(request("GET", undefined, false)))?.status).toBe(401);
    const old = await (await panel(request()))!.json();
    expect(old.settings).toEqual({ dry_run: true, remove_group_fallback: true });
    expect(old.archiveRequested).toBe(false);
    for (const patch of [{ enable: true }, { delete_orphan_profiles: false }, { keep_if_private_possible: true },
      { dry_run: "no" }, { remove_group_fallback: 1 }]) {
      expect((await panel(request("PUT", { patch, revision: old.revision })))?.status).toBe(400);
    }
    const patch = { dry_run: false, remove_group_fallback: false };
    let owner = true;
    expect((await route(request("PUT", { patch, revision: old.revision }), () => {
      const valid = owner;
      owner = false;
      return valid;
    })).status).toBe(401);
    expect(await readFile(config, "utf8")).toBe(beforeFile);
    const saved = (await panel(request("PUT", { patch, revision: old.revision })))!;
    expect(saved.status).toBe(200);
    const after = await saved.json();
    expect(after.settings).toEqual(patch);
    expect((await panel(request("PUT", { patch: { remove_group_fallback: true }, revision: old.revision })))?.status).toBe(409);
    expect(await readFile(config, "utf8")).toStartWith(beforeFile);
    expect(Bun.YAML.parse(await readFile(config, "utf8"))).toMatchObject({ groups: { cleanup: patch },
      permissions: { scopes: { "group.cleanup": { policy: "master_only" } } } });
    expect(await readFile(legacy, "utf8")).toBe(source);
    expect(await readFile(profileFile, "utf8")).toBe(originalProfile);
    expect(await Bun.file(auditPath).exists()).toBe(false);

    const profiles = createProfileStore(profilesDirectory);
    const command = groupCleanupCommands({ profiles, auditPath, readConfig: () => readLotusGlobalConfig(root),
      isMaster: (bot, user) => bot === 99 && user === 42, activeSignal: signal => signal,
      async render() { throw new Error("fixture uses the textual summary"); },
    }).commands["#群清理退群"]!;
    const roster = (ids: readonly number[]) => ids.map(userId => ({ userId, role: "member" as const, joinTime: 0, lastSentTime: 0 }));
    const context = { group_id: 601, self_id: 99, user_id: 42, message_type: "group", isMaster: true,
      groupActivitySignal: new AbortController().signal, async groupActivityRoster() { return roster([99, 42]); } } as const;
    expect(await command("123", { ...context, user_id: 51 })).toMatch(/没有群配置清理权限/u);
    expect(await command("123", context)).toMatch(/拟移除群通知回退　0/u);
    const enableFallback = await panel(request("PUT", { patch: { remove_group_fallback: true }, revision: after.revision }));
    expect(enableFallback?.status).toBe(200);
    expect(await command("123", { ...context, async groupActivityRoster() { return roster([99, 42, 123]); } })).toMatch(/未确认目标已离群/u);
    expect(await command("123 602", context)).toMatch(/已写入清理预览/u);
    expect(await readFile(profileFile, "utf8")).toBe(originalProfile);
    expect(await command("123", context)).toMatch(/已移除群通知回退　1/u);
    expect((await profiles.checkinSettings("123", 1)).notify.fallbackGroups).toEqual([602]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("面板显示旧归档预览状态并保留锚、其他群配置和仍然继承的标志", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-group-cleanup-yaml-"));
  try {
    const root = pathToFileURL(`${directory}/`);
    const legacyDir = join(directory, "plugins/Lotus-ReFactor/config");
    await mkdir(legacyDir, { recursive: true });
    await mkdir(join(directory, "config"));
    await writeFile(join(legacyDir, "global.yaml"), "groups: {cleanup: {delete_orphan_profiles: true, keep_if_private_possible: false}}\n");
    const local = join(directory, "config/global.yaml");
    const source = "defaults: &shared { dry_run: true, unknown: kept }\ngroups:\n  sibling: { flag: true }\n  cleanup: *shared # 保留引用\n";
    await writeFile(local, source);
    const route = panelGroupCleanup(root);
    const before = await (await route(request(), () => true)).json();
    expect(before.archiveRequested).toBe(true);
    const response = await route(request("PUT", { patch: { dry_run: false }, revision: before.revision }), () => true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ settings: { dry_run: false, remove_group_fallback: true }, archiveRequested: true });
    const written = await readFile(local, "utf8");
    expect(written).toContain("defaults: &shared { dry_run: true, unknown: kept }");
    expect(written).toContain("cleanup: {<<: *shared, dry_run: false} # 保留引用");
    expect((await readLotusGlobalConfig(root)).groups).toEqual({ sibling: { flag: true }, cleanup: {
      dry_run: false, unknown: "kept", delete_orphan_profiles: true, keep_if_private_possible: false,
    } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
