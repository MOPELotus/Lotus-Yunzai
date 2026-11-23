import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { accountScopes, type AccountScopeSnapshot } from "../lib/account-scope-policy.ts";
import { checkinPlanCommands } from "../lib/checkin-plan-commands.ts";
import type { CommandContext } from "../lib/commands.ts";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { panelAccountPermissions } from "../lib/panel-account-permissions.ts";
import { panelApi } from "../lib/panel.ts";
import { accountScopePermission } from "../lib/permissions.ts";

const path = "/panel/api/settings/checkin/permissions";
const ordinary = { user_id: 42, group_id: 123, isMaster: false, message_type: "group" } as const satisfies CommandContext;
const owner = { ...ordinary, isMaster: true };
const fixtureToken = "permissions-fixture";

function request(method = "GET", body?: unknown, bearer = fixtureToken) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("签到权限只编辑六项现有作用域并继承其他原权限，撤销权限或版本冲突不覆盖配置", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-scope-"));
  try {
    const root = pathToFileURL(directory + "/");
    const oldDir = join(directory, "plugins/Lotus-Plugin/config");
    await mkdir(oldDir, { recursive: true });
    await mkdir(join(directory, "config"));
    const old = join(oldDir, "global.yaml");
    const original = [
      "permissions:",
      "  default_policy: deny",
      "  users: {allow: [42], deny: [987654321]}",
      "  groups: {deny: [456]}",
      "  scopes:",
      "    checkin.refresh: {policy: inherit, fixture-extra: kept}",
      "    scheduler.manage: {policy: master_only}",
      "    remote.spawn: {policy: deny}",
    ].join("\n") + "\n";
    await writeFile(old, original);
    const localFile = join(directory, "config/global.yaml");
    const local = "# 保留无关内容\r\nscheduler: {enable: false}\r\nprivate_fixture: secret_fixture\r\n";
    await writeFile(localFile, local);
    const route = panelAccountPermissions(root);
    const admin = panelApi(fixtureToken, [], target => target === path ? route : undefined);
    expect((await admin(request("GET", undefined, "other")))?.status).toBe(401);
    const response = await admin(request());
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    const before = await response!.json() as AccountScopeSnapshot;
    expect(Object.keys(before.settings)).toEqual([...accountScopes]);
    expect(before.settings).toMatchObject({
      "checkin.register": "inherit", "checkin.refresh": "inherit", "checkin.group_register": "master_only",
      "scheduler.generate": "master_only", "scheduler.run_due": "master_only", "scheduler.manage": "master_only",
    });
    expect(JSON.stringify(before)).not.toMatch(/987654321|secret_fixture|remote\.spawn/u);
    expect((await admin(request("PUT", { revision: before.revision, patch: { "remote.spawn": "allow" } })))?.status).toBe(400);
    expect((await admin(request("PUT", { revision: before.revision, patch: { "checkin.register": "write_anything" } })))?.status).toBe(400);

    const patch = { "checkin.refresh": "deny", "scheduler.run_due": "allow" };
    let checked = 0;
    expect((await route(request("PUT", { revision: before.revision, patch }), () => ++checked === 1)).status).toBe(401);
    expect(await readFile(localFile, "utf8")).toBe(local);
    const updated = await admin(request("PUT", { revision: before.revision, patch }));
    expect(updated?.status).toBe(200);
    const after = await updated!.json() as AccountScopeSnapshot;
    expect(after.settings).toMatchObject(patch);
    expect(await (await admin(request()))!.json()).toEqual(after);
    expect(await readFile(localFile, "utf8")).toStartWith(local);
    const effective = await readLotusGlobalConfig(root);
    expect(effective.permissions).toMatchObject({ scopes: {
      "checkin.refresh": { policy: "deny", "fixture-extra": "kept" }, "remote.spawn": { policy: "deny" },
    } });
    expect(accountScopePermission(effective, "checkin.refresh")(owner)).toBe(false);
    expect(accountScopePermission(effective, "scheduler.run_due")(ordinary)).toBe(true);
    expect(accountScopePermission(effective, "scheduler.run_due")({ ...ordinary, group_id: 456 })).toBe(false);
    expect(accountScopePermission(effective, "scheduler.run_due")({ ...owner, user_id: 987654321 })).toBe(false);

    const scheduled = {
      enabled: false,
      async generateTomorrow() { throw new Error("disabled fixture"); },
      async personalTomorrow() { throw new Error("unused"); },
      async runDue() { throw new Error("disabled fixture"); },
    };
    const profiles = {
      async listIds() { throw new Error("unused"); },
      async checkinSettings() { throw new Error("unused"); },
    };
    const invoke = (config: Readonly<Record<string, unknown>>) => checkinPlanCommands(profiles, scheduled,
      new AbortController().signal, {
        canGenerate: accountScopePermission(config, "scheduler.generate"),
        canRunDue: accountScopePermission(config, "scheduler.run_due"),
      }).commands["#执行到期签到"]!("", ordinary);
    expect(await invoke(effective)).toBe("全局自动签到已关闭。");

    expect((await admin(request("PUT", { revision: before.revision, patch })))?.status).toBe(409);
    await writeFile(old, original.replace("987654321", "987654322"));
    expect((await admin(request("PUT", { revision: after.revision, patch: { "scheduler.run_due": "master_only" } })))?.status).toBe(409);
    await writeFile(old, original);
    const restored = await admin(request("PUT", { revision: after.revision, patch: {
      "checkin.refresh": "inherit", "scheduler.run_due": "master_only",
    } }));
    expect(restored?.status).toBe(200);
    expect(await restored!.json()).toEqual(before);
    expect(await invoke(await readLotusGlobalConfig(root))).toBe("当前会话无权执行到期签到。");
    expect(await readFile(old, "utf8")).toBe(original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("手工到期签到只在获准且启用时先发进度，再检查计划", async () => {
  const lifecycle = new AbortController();
  const outcomes: string[] = [];
  const schedule = {
    enabled: true,
    async generateTomorrow() { throw new Error("unused"); },
    async personalTomorrow() { throw new Error("unused"); },
    async runDue() { outcomes.push("扫描"); return undefined; },
  };
  const profiles = {
    async listIds() { throw new Error("unused"); },
    async checkinSettings() { throw new Error("unused"); },
  };
  const command = checkinPlanCommands(profiles, schedule, lifecycle.signal, {
    canGenerate: () => false, canRunDue: context => context.isMaster === true,
  }).commands["#执行到期签到"]!;
  const actor = { message_type: "private", user_id: 42, isMaster: true,
    reply(message: unknown) { outcomes.push(String(message)); return true; },
  } as const;
  expect(await command("", { ...actor, isMaster: false })).toBe("当前会话无权执行到期签到。");
  schedule.enabled = false;
  expect(await command("", actor)).toBe("全局自动签到已关闭。");
  expect(outcomes).toEqual([]);
  schedule.enabled = true;
  expect(await command("", actor)).toBe("当前没有到期且未完成的签到任务。");
  expect(outcomes).toEqual(["正在检查并执行到期签到任务。", "扫描"]);
  expect(await command("", { ...actor, reply() { lifecycle.abort(); return false; } })).toBe("");
  expect(outcomes).toHaveLength(2);
});

test("保留作用域、父作用域和权限根的共享 YAML 锚点，仅覆盖选中字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-scope-alias-"));
  try {
    const root = pathToFileURL(directory + "/");
    await mkdir(join(directory, "config"));
    const file = join(directory, "config/global.yaml");
    const header = "\uFEFF# 保留开头和 CRLF\r\n";
    const shared = "default-rule: &rule {policy: inherit, fixture-note: keep}\r\n" +
      "default-scopes: &scopes {checkin.refresh: *rule, remote.spawn: {policy: deny}}\r\n" +
      "default-permissions: &permissions {default_policy: deny, scopes: *scopes}\r\n";
    const route = panelAccountPermissions(root);
    for (const permissions of ["*permissions", "{default_policy: deny, scopes: *scopes}",
      "{default_policy: deny, scopes: {checkin.refresh: *rule, remote.spawn: {policy: deny}}}"]) {
      const common = header + shared;
      await writeFile(file, common + `permissions: ${permissions}  # 保留注释\r\narchive: *permissions\r\n`);
      const before = await (await route(request(), () => true)).json() as AccountScopeSnapshot;
      const response = await route(request("PUT", { revision: before.revision, patch: {
        "checkin.refresh": "deny", "scheduler.generate": "inherit",
      } }), () => true);
      expect(response.status).toBe(200);
      const bytes = await readFile(file, "utf8");
      expect(bytes).toStartWith(common);
      expect(bytes).toContain("  # 保留注释\r\narchive: *permissions\r\n");
      expect(Bun.YAML.parse(bytes)).toMatchObject({
        permissions: { default_policy: "deny", scopes: {
          "checkin.refresh": { policy: "deny", "fixture-note": "keep" }, "scheduler.generate": { policy: "inherit" },
          "remote.spawn": { policy: "deny" },
        } },
        archive: { default_policy: "deny", scopes: { "checkin.refresh": { policy: "inherit", "fixture-note": "keep" } } },
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
