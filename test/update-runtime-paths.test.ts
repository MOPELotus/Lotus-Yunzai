import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateUpdate } from "../lib/update-activation.ts";
import { verifyMovedRuntimePaths } from "../lib/update-runtime-paths.ts";

test("受管切换按 Bun 的显式路径移动独立图鉴和档案，失败后还原", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-update-runtime-"));
  const active = join(dir, "active");
  const candidate = join(dir, "candidate");
  try {
    for (const path of [active, candidate, join(active, "custom"), join(active, "skin", "theme"), join(active, "skin", "fonts"), join(active, "profiles"), join(dir, "outside")]) {
      await mkdir(path, { recursive: true });
    }
    await writeFile(join(active, ".env"), "LOTUS_ATLAS_DATA_DIR=custom\nLOTUS_ATLAS_THEME_DIR=custom/theme\nLOTUS_PROFILE_DIR=ignored\n");
    await writeFile(join(active, "skin", "fonts", "MiSans-VF.ttf"), "fixture adjacent font");
    await writeFile(join(active, "profiles", "42.yaml"), "profile: {id: 1}\n");
    const moduleUrl = new URL("../lib/update-runtime-paths.ts", import.meta.url).href;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      import { readUpdateRuntimePaths } from ${JSON.stringify(moduleUrl)}
      console.log(JSON.stringify(await readUpdateRuntimePaths(process.cwd(), AbortSignal.timeout(2000), {
        PATH: process.env.PATH, LOTUS_PROFILE_DIR: "profiles", LOTUS_ATLAS_THEME_DIR: "skin/theme",
      })))
    `], {
      cwd: active, stdout: "pipe", env: { PATH: process.env.PATH, LOTUS_PROFILE_DIR: join(active, "profiles") },
    });
    const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exit).toBe(0);
    const paths = JSON.parse(stdout);
    expect(paths).toEqual(["custom", "profiles", "skin/fonts/MiSans-VF.ttf", "skin/theme"]);
    const env = {
      LOTUS_ATLAS_DATA_DIR: join(active, "custom"),
      LOTUS_ATLAS_THEME_DIR: join(dir, "outside"),
      LOTUS_PROFILE_DIR: join(active, "profiles"),
    };
    const aborted = activateUpdate(active, candidate, async root => {
      expect(await readFile(join(root, "profiles", "42.yaml"), "utf8")).toBe("profile: {id: 1}\n");
      expect(await readFile(join(root, "skin", "fonts", "MiSans-VF.ttf"), "utf8")).toBe("fixture adjacent font");
      throw new Error("拒绝候选");
    }, paths);
    await expect(aborted).rejects.toThrow("拒绝候选");
    expect(await readFile(join(active, "profiles", "42.yaml"), "utf8")).toBe("profile: {id: 1}\n");
    await expect(verifyMovedRuntimePaths(active, active, env)).rejects.toThrow("仍留在旧版本");
    await expect(verifyMovedRuntimePaths(active, candidate, env)).resolves.toBeUndefined();

    await mkdir(join(candidate, "profiles"));
    await expect(activateUpdate(active, candidate, async () => {}, paths)).rejects.toThrow("占用了持久状态");
    await rm(join(candidate, "profiles"), { recursive: true });
    await symlink(join(dir, "outside"), join(active, "redirect"));
    await expect(activateUpdate(active, candidate, async () => {}, ["redirect/subdir"])).rejects.toThrow("非实体目录");
    expect(await readFile(join(active, "profiles", "42.yaml"), "utf8")).toBe("profile: {id: 1}\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
