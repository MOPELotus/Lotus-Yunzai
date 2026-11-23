import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { atlasResetTarget } from "../plugins/atlas/snapshot-pointer.ts";
import { prepareStartup } from "../scripts/startup.ts";

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
