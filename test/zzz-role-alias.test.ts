import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZzzAliasRegistry, zzzRoleAlias } from "../plugins/atlas/zzz-aliases.ts";

test("Valkey 不可用时仍可查询旧角色别名，歧义名称不绑定到任何角色", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-alias-"));
  try {
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config/alias.yaml"), "安比: [旧别称, 公用称呼]\n零号·安比: [公用称呼]\n");
    const registry = await readZzzAliasRegistry(join(root, "resources"), { hGetAll: async () => { throw Error("offline"); } });
    expect(zzzRoleAlias(registry.groups, "旧别称")).toBe("安比");
    expect(zzzRoleAlias(registry.groups, "公用称呼")).toBeUndefined();
    expect(registry.overrides).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
