import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { readLocalConfig } from "../lib/config.ts";
import { updateLocalConfiguration } from "../lib/lotus-global-config-write.ts";

const names = ["other", "global", "bot", "server", "system-status", "genshin-damage", "remote", "panel-rank", "notice",
  "mys.pushNews", "guides", "zzz-rank", "zzz-panel", "gacha-display", "genshin-wish", "group", "groupAdmin",
  "auto-group-card", "group-leave-blacklist"] as const satisfies readonly Parameters<typeof updateLocalConfiguration>[1][];

async function fixture(run: (path: string, root: URL) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-config-paths-"));
  try { await run(directory, pathToFileURL(directory + "/")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function put(directory: string, path: string, value: string) {
  await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, path), value, { mode: 0o600 });
}

for (const name of names) {
  test(`${name} 修改当前生效的旧配置，保留默认值、扩展字段和注释`, () => fixture(async (directory, root) => {
    const path = `config/config/${name}.yaml`;
    await put(directory, path, "# 原配置\nkeep: 7\nextension: { nested: [one, two] }\n");
    const before = await readLocalConfig(root, name);
    expect(await updateLocalConfiguration(root, name, {
      canWrite: () => true,
      prepare(content, local, effective) {
        expect(local).toEqual(before); expect(effective).toMatchObject(before);
        const document = parseDocument(content); document.set("updated", true);
        return { yaml: document.toString(), value: "saved" };
      },
    })).toBe("saved");
    expect(await readLocalConfig(root, name)).toMatchObject({ keep: 7, extension: { nested: ["one", "two"] }, updated: true });
    expect(await Bun.file(join(directory, `config/${name}.yaml`)).exists()).toBe(false);
    expect(await readFile(join(directory, path), "utf8")).toContain("# 原配置");
  }));
}

test("现代配置明确覆盖旧配置，初始化和修改不合并被覆盖的设置", () => fixture(async (directory, root) => {
  await put(directory, "config/config/other.yaml", "master: ['99:42']\nlegacy: true\n");
  await put(directory, "config/other.yaml", "master: []\nmodern: true\n");
  await updateLocalConfiguration(root, "other", { canWrite: () => true, prepare(content, local) {
    expect(local).toEqual({ master: [], modern: true });
    const document = parseDocument(content); document.set("updated", true); return { yaml: document.toString(), value: true };
  } });
  expect(await readLocalConfig(root, "other")).toEqual({ master: [], modern: true, updated: true });
  expect(await readFile(join(directory, "config/config/other.yaml"), "utf8")).toBe("master: ['99:42']\nlegacy: true\n");
}));

test("显式指定尚不存在的文件时，不改写同名的现代或旧配置", () => fixture(async (directory, root) => {
  await put(directory, "config/config/global.yaml", "keep: legacy\n");
  await put(directory, "config/global.yaml", "keep: modern\n");
  const override = join(directory, "config/custom-global.yaml");
  await updateLocalConfiguration(root, "global", { override, canWrite: () => true, prepare(content, local) {
    expect(local).toEqual({}); expect(content).toBe(""); return { yaml: "custom: true\n", value: true };
  } });
  expect(await readFile(override, "utf8")).toBe("custom: true\n");
  expect(await readFile(join(directory, "config/global.yaml"), "utf8")).toBe("keep: modern\n");
  expect(await readFile(join(directory, "config/config/global.yaml"), "utf8")).toBe("keep: legacy\n");
}));
