import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GlobalPermissionSnapshot } from "../lib/global-permission-policy.ts";
import { readLotusGlobalConfig } from "../lib/lotus-global-config.ts";
import { panelGlobalPermissions } from "../lib/panel-global-permissions.ts";
import { panelApi } from "../lib/panel.ts";
import { accountScopePermission } from "../lib/permissions.ts";
import { PermissionService } from "../plugins/media/core/permissions/service.ts";

const routePath = "/panel/api/settings/global/permissions";
const token = "global-permissions-fixture";
function request(method = "GET", payload?: unknown, bearer = token) {
  return new Request(`http://localhost${routePath}`, {
    method, headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

test("只更新显式保存的业务权限，保留别名、无关源码和消费者既有优先级", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-global-permissions-"));
  try {
    const root = pathToFileURL(directory + "/");
    await mkdir(join(directory, "config"));
    const local = join(directory, "config/global.yaml");
    const original = [
      "# 保留文件格式",
      "permissionControl: {whiteList: [11111]} # 保留旧来源",
      "permissions:",
      "  default_policy: allow # 保留策略注释",
      "  users:",
      "    allow:",
      "      - 22222 # 保留用户注释",
      '      - " 33333 " # 保留非规范项',
      "      - 44444",
      "  groups: {deny: [67890], extra: unchanged}",
      "  scopes:",
      "    scheduler.manage: {policy: allow}",
      "    checkin.refresh: {policy: inherit}",
      "    group.cleanup: {policy: master_only}",
      "    video.download: {policy: inherit, extra: keep}",
      "private_fixture: retained",
      "",
    ].join("\r\n");
    await writeFile(local, original);
    const startup = await readLotusGlobalConfig(root);
    const route = panelGlobalPermissions(root);
    const api = panelApi(token, [], path => path === routePath ? route : undefined);
    const call = (method?: string, payload?: unknown) => api(request(method, payload));
    expect((await api(request("GET", undefined, "unauthorized")))?.status).toBe(401);
    const response = await call();
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    const before = await response!.json() as GlobalPermissionSnapshot;
    expect(before.locked).toEqual({ "users.allow": ["11111"] });
    expect(before.retained).toEqual({ "users.allow": 1 });
    expect(before.settings).toMatchObject({ "users.allow": ["11111", "22222", "44444"], "groups.deny": ["67890"] });
    expect(JSON.stringify(before)).not.toMatch(/scheduler.manage|private_fixture/u);
    expect(await readFile(local, "utf8")).toBe(original);

    const put = (patch: unknown, revision = before.revision) => call("PUT", { revision, patch });
    expect((await put({ "scopes.group.cleanup": "allow" }))?.status).toBe(400);
    expect((await put({ "groups.allow": ["0001", "9007199254740993"] }))?.status).toBe(400);
    expect((await put({ default_policy: "inherit" }))?.status).toBe(400);
    expect((await put({ "users.allow": ["22222"] }))?.status).toBe(422);
    expect((await put({ "users.allow": ["44444", "11111", "22222"] }))?.status).toBe(200);
    const patch = {
      default_policy: "deny", "users.allow": ["11111", "22222"], "users.deny": ["55555"], "groups.allow": ["12345"],
    };
    let checks = 0;
    expect((await route(request("PUT", { revision: before.revision, patch }), () => ++checks === 1)).status).toBe(401);
    expect(await readFile(local, "utf8")).toBe(original);
    const saved = await put(patch);
    expect(saved?.status).toBe(200);
    const after = await saved!.json() as GlobalPermissionSnapshot;
    expect(after.settings).toMatchObject(patch);
    const yaml = await readFile(local, "utf8");
    expect(yaml).toContain("permissionControl: {whiteList: [11111]} # 保留旧来源\r\n");
    expect(yaml).toContain('# 保留策略注释\r\n');
    expect(yaml).toContain('      - 22222 # 保留用户注释\r\n      - " 33333 " # 保留非规范项\r\n');
    expect(yaml).not.toContain("44444");
    expect(yaml.match(/11111/gu)).toHaveLength(1);
    expect(yaml).toContain("  scopes:\r\n    scheduler.manage: {policy: allow}\r\n");
    expect(yaml).toEndWith("    video.download: {policy: inherit, extra: keep}\r\nprivate_fixture: retained\r\n");
    expect(yaml.replaceAll("\r\n", "")).not.toContain("\n");

    const live = await readLotusGlobalConfig(root);
    const media = new PermissionService({ permissions: live.permissions });
    const subject = { user_id: 66666, group_id: 77777, isMaster: false };
    expect(accountScopePermission(startup, "checkin.refresh")(subject)).toBe(true);
    const refresh = accountScopePermission(live, "checkin.refresh");
    expect(refresh(subject)).toBe(false);
    expect(refresh({ ...subject, user_id: 11111 })).toBe(true);
    expect(refresh({ ...subject, user_id: 33333 })).toBe(true);
    expect(refresh({ ...subject, group_id: 12345 })).toBe(true);
    expect(accountScopePermission(live, "scheduler.manage")(subject)).toBe(true);
    expect(accountScopePermission(live, "scheduler.manage")({ ...subject, group_id: 67890, isMaster: true })).toBe(false);
    expect(accountScopePermission(live, "group.cleanup")({ ...subject, group_id: 12345 })).toBe(false);
    expect(accountScopePermission(live, "group.cleanup")({ ...subject, isMaster: true })).toBe(true);
    expect(accountScopePermission(live, "group.cleanup")({ ...subject, user_id: 55555, isMaster: true })).toBe(false);
    expect(media.explain(subject, "video.download").reason).toBe("default_deny");
    expect(media.explain({ ...subject, user_id: 22222 }, "video.download").reason).toBe("user_allow");
    expect(media.explain({ ...subject, group_id: 67890, isMaster: true }, "video.download").reason).toBe("group_deny");
    expect((await put({ "groups.deny": [] }))?.status).toBe(409);

    const results = await Promise.all([
      put({ "groups.deny": [] }, after.revision), put({ "groups.allow": [] }, after.revision),
    ]);
    expect(results.map(result => result?.status).sort()).toEqual([200, 409]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("独立旧模块名单允许在现配置覆盖，并保留共享 YAML 锚点与其余规则", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-global-permissions-inherited-"));
  try {
    const root = pathToFileURL(directory + "/");
    await mkdir(join(directory, "config"));
    const oldConfig = join(directory, "plugins/Lotus-ReFactor/config");
    await mkdir(oldConfig, { recursive: true });
    const legacy = "permission_control: {white_list: [22222]}\n";
    const old = join(oldConfig, "global.yaml");
    await writeFile(old, legacy);
    const local = join(directory, "config/global.yaml");
    const header = "policy_ref: &policy {scopes: {scheduler.manage: {policy: allow}}, groups: {deny: [55555]}}\n";
    await writeFile(local, header + "permissions: *policy # keep\nother: *policy\n");
    const handler = panelGlobalPermissions(root);
    const serve = (method?: string, payload?: unknown) => handler(request(method, payload), () => true);
    const before = await (await serve()).json() as GlobalPermissionSnapshot;
    expect(before.settings["users.allow"]).toEqual(["22222"]);
    expect(before.locked).toEqual({});
    const edited = await serve("PUT", { revision: before.revision, patch: { "users.allow": [], "groups.deny": [] } });
    expect(edited.status).toBe(200);
    const after = await edited.json() as GlobalPermissionSnapshot;
    expect(after.settings).toMatchObject({ "users.allow": [], "groups.deny": [] });
    const actual = await readFile(local, "utf8");
    expect(actual).toStartWith(header);
    expect(actual).toEndWith(" # keep\nother: *policy\n");
    expect(Bun.YAML.parse(actual)).toMatchObject({
      permissions: { users: { allow: [] }, groups: { deny: [] }, scopes: { "scheduler.manage": { policy: "allow" } } },
      other: { groups: { deny: [55555] } },
    });
    expect(await readFile(old, "utf8")).toBe(legacy);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
