import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelMediaOwnerPermissions } from "../lib/panel-account-permissions.ts";
import { panelApi } from "../lib/panel.ts";
import { loadGlobalConfig } from "../plugins/media/core/config/global.ts";
import { PermissionService } from "../plugins/media/core/permissions/service.ts";

test("媒体主人权限只保存三项现行策略并保留未经编辑的历史取值", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-media-owner-policy-"));
  try {
    const root = pathToFileURL(directory + "/");
    const legacy = join(directory, "plugins/Lotus-ReFactor/config");
    const local = join(directory, "config");
    await mkdir(legacy, { recursive: true });
    await mkdir(local);
    const old = "permissions: {users: {deny: [765432109]}, groups: {deny: [678901234]}, scopes: {bilibili.login: {policy: allow}, netease.partner: {}}}\n";
    const oldFile = join(legacy, "global.yaml");
    const localFile = join(local, "global.yaml");
    const before = "# 本地注释\npermissions: {scopes: {tools.install: {policy: inherit, fixture: retained}, douyin.download: {policy: deny}}}\n";
    await writeFile(oldFile, old);
    await writeFile(localFile, before);

    const route = panelMediaOwnerPermissions(root);
    const endpoint = "/panel/api/settings/media/owner-permissions";
    const panel = panelApi("local-fixture", [], path => path === endpoint ? route : undefined);
    const request = (method = "GET", body?: unknown, authorized = true) => new Request("http://localhost" + endpoint, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(authorized ? { Authorization: "Bearer local-fixture" } : {}), "Content-Type": "application/json" },
    });
    const read = async () => (await panel(request()))!.json();
    const owner = { user_id: 42, group_id: 51, isMaster: true };
    const permissions = async () => {
      const { permissions } = await loadGlobalConfig(root);
      const { scopes, ...shared } = permissions;
      return new PermissionService({ permissions: { ...shared, scopes: { "netease.partner": { policy: "master_only" }, ...scopes } } });
    };
    const initial = await read();
    expect(initial.settings).toEqual({
      "bilibili.login": "master_only", "tools.install": "master_only", "netease.partner": "inherit",
    });
    expect(JSON.stringify(initial)).not.toContain("765432109");
    expect((await permissions()).can(owner, "tools.install")).toBe(true);
    expect((await permissions()).can({ ...owner, isMaster: false }, "bilibili.login")).toBe(false);

    const change = (patch: unknown, revision = initial.revision, authorized = true) => panel(request("PUT", { revision, patch }, authorized));
    expect((await panel(request("GET", undefined, false)))?.status).toBe(401);
    expect((await change({ "netease.partner": "deny" }, initial.revision, false))?.status).toBe(401);
    for (const patch of [{ "tools.install": "allow" }, { "bilibili.login": "inherit" }, { "bilibili.download": "allow" }]) {
      expect((await change(patch))?.status).toBe(400);
    }
    expect((await change({ "bilibili.login": "master_only", "tools.install": "master_only" }))?.status).toBe(200);
    expect(await readFile(localFile, "utf8")).toBe(before);

    let authorized = true;
    const deny = { revision: initial.revision, patch: { "netease.partner": "deny" } };
    expect((await route(request("PUT", deny), () => {
      const active = authorized;
      authorized = false;
      return active;
    })).status).toBe(401);
    expect((await change(deny.patch))?.status).toBe(200);
    const partnerOnly = await read();
    expect((await permissions()).can(owner, "netease.partner")).toBe(false);
    expect((await permissions()).can(owner, "bilibili.login")).toBe(true);
    const localSource = await readFile(localFile, "utf8");
    expect(localSource).toContain("# 本地注释");
    expect(localSource).toContain("tools.install: {policy: inherit, fixture: retained}");
    expect(await readFile(oldFile, "utf8")).toBe(old);

    // A concurrent old value can still have the same effective policy. Preserve it and require a new read.
    await writeFile(localFile, localSource.replace("policy: inherit, fixture:", "policy: allow, fixture:"));
    expect((await read()).settings).toEqual(partnerOnly.settings);
    expect((await change({ "tools.install": "deny" }, partnerOnly.revision))?.status).toBe(409);

    const current = await read();
    const saved = await change({ "bilibili.login": "deny", "tools.install": "deny", "netease.partner": "allow" }, current.revision);
    expect(saved?.status).toBe(200);
    expect(await saved!.json()).toEqual(await read());
    const active = await permissions();
    expect(active.can(owner, "netease.partner")).toBe(true);
    for (const subject of [{ ...owner, user_id: 765432109 }, { ...owner, group_id: 678901234 }]) {
      expect(active.can(subject, "netease.partner")).toBe(false);
    }
    expect(active.can(owner, "bilibili.login")).toBe(false);
    expect(active.can(owner, "tools.install")).toBe(false);
    expect(await readFile(localFile, "utf8")).toContain("fixture: retained");
    expect(await readFile(oldFile, "utf8")).toBe(old);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
