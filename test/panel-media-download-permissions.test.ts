import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelAccountPermissions, panelMediaDownloadPermissions, panelMediaPreviewPermissions } from "../lib/panel-account-permissions.ts";
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
    expect(before.settings).toEqual({
      "bilibili.download": "deny", "douyin.download": "inherit", "acfun.play": "inherit",
      "pipixia.download": "inherit", "weishi.play": "inherit", "zuiyou.play": "inherit", "kuaishou.download": "inherit",
    });
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
    const patch = {
      "bilibili.download": "allow", "douyin.download": "master_only", "acfun.play": "deny",
      "pipixia.download": "master_only", "weishi.play": "allow", "zuiyou.play": "deny", "kuaishou.download": "master_only",
    };
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
    expect(active.can(regular, "pipixia.download")).toBe(false);
    expect(active.can(owner, "pipixia.download")).toBe(true);
    expect(active.can(regular, "weishi.play")).toBe(true);
    expect(active.can(owner, "zuiyou.play")).toBe(false);
    expect(active.can(listed, "kuaishou.download")).toBe(false);
    expect(active.can(owner, "kuaishou.download")).toBe(true);
    for (const subject of [{ ...owner, user_id: 765432109 }, { ...owner, group_id: 678901234 }]) {
      expect(active.can(subject, "bilibili.download")).toBe(false);
      expect(active.can(subject, "douyin.download")).toBe(false);
    }
    expect(await readFile(legacy, "utf8")).toBe(source);
    expect(Bun.YAML.parse(await readFile(local, "utf8"))).toEqual({ permissions: { scopes: {
      "checkin.refresh": { policy: "master_only" }, "bilibili.download": { policy: "allow" }, "douyin.download": { policy: "master_only" },
      "acfun.play": { policy: "deny" },
      "pipixia.download": { policy: "master_only" }, "weishi.play": { policy: "allow" }, "zuiyou.play": { policy: "deny" },
      "kuaishou.download": { policy: "master_only" },
    } } });
    const revision = (await read()).revision;
    expect((await admin(request("PUT", { revision, patch: before.settings })))?.status).toBe(200);
    expect(await read()).toEqual(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("五项媒体预览权限从原配置读写并立即用于媒体解析", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-media-preview-"));
  try {
    const root = pathToFileURL(directory + "/");
    const config = join(directory, "config");
    await mkdir(config);
    const file = join(config, "global.yaml");
    await writeFile(file, "# 原策略\npermissions:\n  groups: {deny: [123]}\n  scopes:\n    wxchannels.preview: {policy: deny}\n    weishi.play: {policy: master_only}\n");
    const route = panelMediaPreviewPermissions(root);
    const path = "/panel/api/settings/media/preview-permissions";
    const admin = panelApi(key, [], routePath => routePath === path ? route : undefined);
    const call = (method = "GET", body?: unknown, authorized = true) => admin(new Request("http://localhost" + path, {
      method, headers: { ...(authorized && { Authorization: `Bearer ${key}` }), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    expect((await call("GET", undefined, false))?.status).toBe(401);
    const before = await (await call())!.json();
    expect(before.settings).toEqual({ "acfun.preview": "inherit", "weishi.preview": "inherit", "zuiyou.preview": "inherit",
      "wxchannels.preview": "deny", "xigua.preview": "inherit" });
    const patch = { "acfun.preview": "deny", "weishi.preview": "master_only", "zuiyou.preview": "allow",
      "wxchannels.preview": "inherit", "xigua.preview": "deny" };
    const saved = await call("PUT", { revision: before.revision, patch });
    expect(saved?.status).toBe(200);
    expect((await saved!.json()).settings).toEqual(patch);
    expect((await call("PUT", { revision: before.revision, patch }))?.status).toBe(409);
    const { permissions } = await loadGlobalConfig(root);
    const service = new PermissionService({ permissions });
    const peer = { user_id: 42, group_id: 456, isMaster: false };
    expect(service.can(peer, "xigua.preview")).toBe(false);
    expect(service.can(peer, "acfun.preview")).toBe(false);
    expect(service.can(peer, "weishi.preview")).toBe(false);
    expect(service.can({ ...peer, isMaster: true }, "weishi.preview")).toBe(true);
    expect(service.can(peer, "zuiyou.preview")).toBe(true);
    expect(service.can({ ...peer, group_id: 123 }, "zuiyou.preview")).toBe(false);
    expect((await readFile(file, "utf8"))).toContain("weishi.play: {policy: master_only}");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
