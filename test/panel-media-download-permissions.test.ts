import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelAccountPermissions, panelMediaDownloadPermissions } from "../lib/panel-account-permissions.ts";
import { panelApi } from "../lib/panel.ts";
import { loadGlobalConfig } from "../plugins/media/core/config/global.ts";
import { PermissionService } from "../plugins/media/core/permissions/service.ts";

const endpoint = "http://localhost/panel/api/settings/media/download-permissions";
const key = "media-policy-fixture";
function request(method = "GET", body?: unknown, authorized = true) {
  return new Request(endpoint, { method,
    headers: { ...(authorized ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("媒体下载权限复用原策略写入，作用域与签到隔离，真实媒体读取仍先检查拒绝名单", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-media-policy-"));
  try {
    const root = pathToFileURL(`${directory}/`);
    const legacyDir = join(directory, "plugins/Lotus-Plugin/config");
    await mkdir(legacyDir, { recursive: true });
    await mkdir(join(directory, "config"));
    const legacy = join(legacyDir, "global.yaml");
    const source = "permissions:\n  default_policy: deny\n  users: {allow: [42], deny: [765432109]}\n  groups: {deny: [678901234]}\n" +
      "  scopes: {bilibili.download: {policy: [deny]}, douyin.download: {policy: inherit, fixture: preserved}, tools.install: {policy: deny}}\n";
    await writeFile(legacy, source);
    const local = join(directory, "config/global.yaml");
    const yaml = "# 原配置\r\npermissions: {scopes: {checkin.refresh: {policy: master_only}}}\r\n";
    await writeFile(local, yaml);
    const route = panelMediaDownloadPermissions(root);
    const admin = panelApi(key, [], () => route);
    expect((await admin(request("GET", undefined, false)))?.status).toBe(401);
    const read = async () => (await admin(request()))!.json();
    const beforeRaw = await (await admin(request()))!.text();
    expect(beforeRaw).not.toContain("765432109");
    expect(beforeRaw).not.toContain("678901234");
    const before = JSON.parse(beforeRaw);
    expect(before.settings).toEqual({ "bilibili.download": "deny", "douyin.download": "inherit", "acfun.play": "inherit" });
    const regular = { user_id: 51, group_id: 99, isMaster: false };
    const listed = { ...regular, user_id: 42 };
    const owner = { ...regular, isMaster: true };
    const policy = async () => new PermissionService({ permissions: (await loadGlobalConfig(root)).permissions });
    expect((await policy()).can(listed, "bilibili.download")).toBe(false);
    expect((await policy()).can(listed, "douyin.download")).toBe(true);
    expect((await policy()).can(regular, "douyin.download")).toBe(false);
    for (const patch of [{ "tools.install": "allow" }, { "bilibili.login": "allow" }, { "checkin.refresh": "allow" },
      { default_policy: "allow" }, { "bilibili.download": "ALLOW" }]) {
      expect((await admin(request("PUT", { revision: before.revision, patch })))?.status).toBe(400);
    }
    const account = panelAccountPermissions(root);
    const checkin = await (await account(request(), () => true)).json();
    expect((await account(request("PUT", { revision: checkin.revision, patch: { "bilibili.download": "deny" } }), () => true)).status).toBe(400);
    const patch = { "bilibili.download": "allow", "douyin.download": "master_only", "acfun.play": "deny" };
    let authorized = true;
    expect((await route(request("PUT", { revision: before.revision, patch }), () => {
      const valid = authorized;
      authorized = false;
      return valid;
    })).status).toBe(401);
    expect(await readFile(local, "utf8")).toBe(yaml);
    const saved = (await admin(request("PUT", { revision: before.revision, patch })))!;
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toEqual(patch);
    expect((await admin(request("PUT", { revision: before.revision, patch: before.settings })))?.status).toBe(409);
    const active = await policy();
    expect(active.can(regular, "bilibili.download")).toBe(true);
    expect(active.can(listed, "douyin.download")).toBe(false);
    expect(active.can(owner, "douyin.download")).toBe(true);
    expect(active.can(owner, "acfun.play")).toBe(false);
    for (const subject of [{ ...owner, user_id: 765432109 }, { ...owner, group_id: 678901234 }]) {
      expect(active.can(subject, "bilibili.download")).toBe(false);
      expect(active.can(subject, "douyin.download")).toBe(false);
    }
    expect(await readFile(legacy, "utf8")).toBe(source);
    expect(Bun.YAML.parse(await readFile(local, "utf8"))).toEqual({ permissions: { scopes: {
      "checkin.refresh": { policy: "master_only" }, "bilibili.download": { policy: "allow" }, "douyin.download": { policy: "master_only" },
      "acfun.play": { policy: "deny" },
    } } });
    const revision = (await read()).revision;
    expect((await admin(request("PUT", { revision, patch: before.settings })))?.status).toBe(200);
    expect(await read()).toEqual(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
