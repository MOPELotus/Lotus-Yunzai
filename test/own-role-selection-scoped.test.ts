import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileStore, withGameCommandProfiles } from "@lotus-yunzai/account";
import { selectOwnRole } from "../lib/own-role-selection.ts";

function document(id: number, roles: { uid: string; region: string }[]) {
  return { user: { qq: "42" }, profile: { id }, account: {
    stuid: "99042", stoken: "fixture-token", cookie: "ltuid=99042; ltoken=fixture-cookie",
    current_uid: { gs: roles[0]!.uid }, game_roles: {
      gs: roles.map(role => ({ ...role, game_biz: "hk4e_cn", nickname: "角色样本" })), sr: [], zzz: [],
    },
  } };
}

test("当前游戏档案仅列本档案官服和B服，选角不读取他档也不改变默认档案", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-role-current-profile-"));
  const oldTheme = Bun.env.LOTUS_PASSPORT_QR_RESOURCES;
  Bun.env.LOTUS_PASSPORT_QR_RESOURCES = join(root, "missing-theme");
  try {
    await writeFile(join(root, "42.yaml"), Bun.YAML.stringify(document(1, [{ uid: "100000099", region: "cn_gf01" }])));
    await writeFile(join(root, "42-2.yaml"), Bun.YAML.stringify(document(2, [
      { uid: "100000042", region: "cn_gf01" }, { uid: "500000042", region: "cn_qd01" },
    ])));
    const firstBefore = await readFile(join(root, "42.yaml"), "utf8");
    const store = createProfileStore(root), reads: number[] = [];
    const profiles = { ...store, async roleCatalog(qq: string, id: number) { reads.push(id); return store.roleCatalog(qq, id); } };
    const scope = { user: 42, signal: new AbortController().signal, isCurrent: () => true };
    const commandProfiles = { user: 42, profiles: { gs: 2 } as const, isCurrent: () => true };
    const run = (selection: Parameters<typeof selectOwnRole>[1]) => withGameCommandProfiles(commandProfiles,
      () => selectOwnRole(profiles, selection, scope));
    const listed = await run({ game: "gs" });
    expect(listed).toContain("档案 2");
    expect(listed).toContain("天空岛");
    expect(listed).toContain("世界树");
    expect(listed).not.toContain("100000099");
    expect(await run({ game: "gs", slot: 2 })).toContain("当前角色已选为 500000042");
    expect((await store.savedRole("42", 2, "gs")).uid).toBe("500000042");
    expect((await store.savedRole("42", 2, "gs")).region).toBe("cn_qd01");
    expect(await run({ game: "gs", uid: "100000099" })).toContain("档案 2 没有此原神角色");
    expect(reads).toEqual([2, 2, 2]);
    expect(await readFile(join(root, "42.yaml"), "utf8")).toBe(firstBefore);
    const explicit = await run({ game: "gs", profileId: 1 });
    expect(explicit).toContain("档案 1");
    expect(explicit).toContain("100000099");
    expect(explicit).not.toContain("500000042");
    expect(commandProfiles.profiles).toEqual({ gs: 2 });
  } finally {
    if (oldTheme === undefined) delete Bun.env.LOTUS_PASSPORT_QR_RESOURCES;
    else Bun.env.LOTUS_PASSPORT_QR_RESOURCES = oldTheme;
    await rm(root, { recursive: true, force: true });
  }
});

test("会话和档案修订在选角期间变化时不提交，越界序号不读档案", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-role-scope-"));
  try {
    await writeFile(join(root, "42.yaml"), Bun.YAML.stringify(document(1, [
      { uid: "100000042", region: "cn_gf01" }, { uid: "500000042", region: "cn_qd01" },
    ])));
    const store = createProfileStore(root), source = join(root, "42.yaml");
    const before = await readFile(source, "utf8");
    let current = true, reads = 0;
    const scope = { user: 42, signal: new AbortController().signal, isCurrent: () => current };
    const cancelled = { ...store, async requestContext(...args: Parameters<typeof store.requestContext>) {
      const result = await store.requestContext(...args); current = false; return result;
    } };
    expect(await selectOwnRole(cancelled, { game: "gs", slot: 2 }, scope)).toBeUndefined();
    expect(await readFile(source, "utf8")).toBe(before);
    current = true;
    const stale = { ...store, async requestContext(...args: Parameters<typeof store.requestContext>) {
      const result = await store.requestContext(...args); return { ...result, revision: "changed-revision" };
    } };
    expect(await selectOwnRole(stale, { game: "gs", slot: 2 }, scope)).toContain("档案在操作期间已更新");
    expect(await readFile(source, "utf8")).toBe(before);
    const guarded = { ...store, async roleCatalog(...args: Parameters<typeof store.roleCatalog>) { reads++; return store.roleCatalog(...args); } };
    expect(await selectOwnRole(guarded, { game: "gs", slot: 100 }, scope)).toContain("角色序号须在");
    expect(reads).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
