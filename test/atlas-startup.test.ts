import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { atlasResetTarget } from "../plugins/atlas/snapshot-pointer.ts";
import { prepareStartup } from "../scripts/startup.ts";
import { assertInitializationComplete, beginInitialization } from "../lib/initialization-state.ts";

test("普通启动在图鉴重置时仍可继续，且保留重置指针", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-startup-"));
  try {
    const atlas = join(directory, "data/atlas");
    await mkdir(atlas, { recursive: true });
    const pointer = join(atlas, "current");
    await symlink(atlasResetTarget, pointer);
    await Bun.write(join(directory, "plugins/atlas/initialize-atlas.ts"), "");
    const root = pathToFileURL(directory + "/");
    await prepareStartup(root, undefined, AbortSignal.timeout(2_000));
    expect(await readlink(pointer)).toBe(atlasResetTarget);
    expect(await Bun.file(join(directory, "config/global.yaml")).exists()).toBeFalse();
    expect(await Bun.file(join(directory, "data/atlas-download/.download.sqlite")).exists()).toBeFalse();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("普通启动保留便笺素材回退，显式初始化缺少必需素材时保留未完成标记", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-atlas-startup-note-"));
  const warning = console.warn;
  const priorTheme = Bun.env.LOTUS_ATLAS_THEME_DIR;
  Bun.env.LOTUS_ATLAS_THEME_DIR = join(directory, "isolated-theme");
  const warnings: string[] = [];
  try {
    const root = pathToFileURL(directory + "/");
    await Bun.write(join(directory, "plugins/atlas/initialize-atlas.ts"), "");
    await Bun.write(join(directory, "data/atlas/data/map.json"), JSON.stringify({
      games: { gi: { locales: { zh: { pages: { character: {
        version: "夹具", recordCount: 1, records: { "1": { id: "1", name: "夹具角色", path: "items/fixture.json" } },
      } } } } } },
    }));
    const resources = join(directory, "data/daily-note/resources");
    const supplied = join(directory, "isolated-daily-note");
    await mkdir(join(directory, "data/daily-note"), { recursive: true });
    await mkdir(supplied);
    // An operator-provided linked partial theme remains untouched at ordinary startup.
    await symlink(supplied, resources);
    const font = join(resources, "miao-theme/fonts/HYWH-65W.ttf");
    await Bun.write(font, "原有本地字体");
    console.warn = (line: unknown) => { warnings.push(String(line)); };

    await prepareStartup(root, undefined, AbortSignal.timeout(2_000));
    const incomplete = warnings.find(line => line.startsWith("[体力]"));
    expect(incomplete).toContain("补齐");
    expect(incomplete).toContain("LOTUS_DAILY_NOTE_RESOURCES");
    expect(incomplete).not.toContain("bun run init");
    expect(await Bun.file(font).text()).toBe("原有本地字体");

    const unreadable = join(resources, "fonts/MiSans-VF.ttf");
    await mkdir(join(resources, "fonts"));
    await symlink(unreadable, unreadable);
    warnings.length = 0;
    await prepareStartup(root, undefined, AbortSignal.timeout(2_000));
    const ioFailures = warnings.filter(line => line.startsWith("[体力]"));
    expect(ioFailures).toHaveLength(1);
    expect(ioFailures.every(line => line.includes("使用文字回执"))).toBe(true);
    expect(await readlink(unreadable)).toBe(unreadable);
    expect(await Bun.file(font).text()).toBe("原有本地字体");

    const runId = await beginInitialization(root);
    await expect(prepareStartup(root, undefined, AbortSignal.timeout(2_000), true))
      .rejects.toThrow("图鉴内置素材缺失");
    expect(await Bun.file(join(directory, "data/.initialization-pending.json")).json()).toMatchObject({ runId });
    await expect(assertInitializationComplete(root)).rejects.toThrow("bootstrap");
    expect(await readlink(unreadable)).toBe(unreadable);
    expect(await Bun.file(font).text()).toBe("原有本地字体");
  } finally {
    console.warn = warning;
    if (priorTheme === undefined) delete Bun.env.LOTUS_ATLAS_THEME_DIR; else Bun.env.LOTUS_ATLAS_THEME_DIR = priorTheme;
    await rm(directory, { recursive: true, force: true });
  }
});
