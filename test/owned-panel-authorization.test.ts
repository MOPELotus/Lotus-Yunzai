import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "@lotus-yunzai/account";
import { ownedPanelAuthorization } from "../lib/owned-panel-authorization.ts";

test("面板导出仅授权本档案本人角色，换号及失效会话立即撤权且不修改选角", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-owned-panel-proof-"));
  const profile = (id: number, uid: string) => ({ user: { qq: "42" }, profile: { id }, account: {
    stuid: "99042", stoken: "fixture-token", cookie: "ltuid=99042; ltoken=fixture-cookie",
    current_uid: { gs: uid }, game_roles: { gs: [{ uid, region: "cn_gf01", game_biz: "hk4e_cn" }], sr: [], zzz: [] },
  } });
  try {
    await writeFile(join(directory, "42.yaml"), Bun.YAML.stringify(profile(1, "100000099")));
    const path = join(directory, "42-2.yaml");
    await writeFile(path, Bun.YAML.stringify(profile(2, "100000042")));
    const original = await readFile(path, "utf8"), store = createProfileStore(directory);
    const controller = new AbortController();
    let current = true;
    const scope = { user: 42, signal: controller.signal, isCurrent: () => current };
    expect(await ownedPanelAuthorization(store, "gs", "100000099", 2, scope)).toBeUndefined();
    const authorization = await ownedPanelAuthorization(store, "gs", "100000042", 2, scope);
    expect(authorization).toBeDefined();
    expect(await authorization!()).toBe(true);
    expect(await readFile(path, "utf8")).toBe(original);
    current = false;
    expect(await authorization!()).toBe(false);
    current = true;
    const changed = profile(2, "100000042");
    changed.account.stuid = "99043";
    changed.account.cookie = "ltuid=99043; ltoken=fixture-other-account";
    await writeFile(path, Bun.YAML.stringify(changed));
    expect(await authorization!()).toBe(false);
    const renewed = await ownedPanelAuthorization(store, "gs", "100000042", 2, scope);
    expect(renewed).toBeDefined();
    controller.abort();
    expect(await renewed!()).toBe(false);
    expect(await ownedPanelAuthorization(store, "gs", "100000042", 2, scope)).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
