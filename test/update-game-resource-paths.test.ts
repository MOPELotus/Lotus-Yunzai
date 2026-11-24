import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { activateUpdate } from "../lib/update-activation.ts";
import { readUpdateRuntimePaths, verifyMovedRuntimePaths } from "../lib/update-runtime-paths.ts";
import { createWishPoolSource } from "../plugins/genshin/wish-sim/pools.ts";
import { readZzzRoleAliases, zzzRoleAlias } from "../plugins/zzz/role-alias.ts";

test("受管更新保留有效游戏主题、旧个人卡池与绝区零相邻配置", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "lotus-update-game-resources-"));
  const active = join(fixture, "active");
  const candidate = join(fixture, "candidate");
  const wish = "portable/plugins/flower";
  const zzz = "portable/zzz/resources ";
  const paths = {
    LOTUS_GENSHIN_WISH_LEGACY_DIR: `  ${wish}  `,
    LOTUS_GENSHIN_GACHA_RESOURCES_DIR: "  portable/genshin/resources  ",
    LOTUS_GENSHIN_RANK_THEME_DIR: "  themes/original  ",
    LOTUS_GENSHIN_ARK_THEME_DIR: "themes/unused",
    LOTUS_STAR_RAIL_CHALLENGE_THEME_DIR: "  themes/challenge  ",
    LOTUS_ZZZ_LEGACY_RESOURCES_DIR: zzz,
    LOTUS_ZZZ_PANEL_CONFIG: "portable/zzz/custom-panel.yaml ",
  } as const;
  const files = new Map([
    ["themes/original/common/bg.png", "当前原神主题"], ["themes/unused/bg.png", "旧排名备用主题"],
    ["themes/challenge/floor12.png", "旧深渊主题"], [join(zzz, "role.json"), "原始资源"],
    ["portable/zzz/config/alias.yaml", "艾莲: [隔离鲨鱼]\n"], ["portable/zzz/config/rank.yaml", "max_display: 6\n"],
    ["portable/zzz/config/panel.yaml", "interval: 12\n"], [paths.LOTUS_ZZZ_PANEL_CONFIG, "interval: 30\n"],
    ["portable/zzz/dist/model/damage/character/ellen.json", "原伤害配置"],
    [join(wish, "resources/single/img/bg.png"), "原祈愿主题"],
    ["genshin/defSet/element/role.yaml", "菲林斯: 电\n"],
    ["portable/genshin/resources/img/overview.png", "原神主题"],
    ["portable/genshin/defSet/role/index.yaml", "common_chest: 4000\n"],
    ["portable/genshin/defSet/weapon/other.yaml", "actWeapon: [铁蜂刺]\n"],
    ["portable/genshin/config/role.index.yaml", "common_chest: 2\n"],
  ]);
  try {
    await mkdir(candidate);
    for (const [path, contents] of files) {
      await mkdir(dirname(join(active, path)), { recursive: true });
      await writeFile(join(active, path), contents);
    }
    const personalPool = join(active, wish, "data/42/pool.yaml");
    await mkdir(dirname(personalPool), { recursive: true });
    await copyFile(new URL("../plugins/genshin/wish-sim/flower/pool.yaml", import.meta.url), personalPool);
    await writeFile(join(active, ".env"), Object.entries(paths).map(([key, value]) => `${key}=${JSON.stringify(value)}\n`).join(""));

    const selected = await readUpdateRuntimePaths(active, AbortSignal.timeout(3_000), { PATH: process.env.PATH });
    expect(selected).toEqual([
      "genshin/defSet/element/role.yaml",
      "portable/genshin/defSet/role/index.yaml", "portable/genshin/defSet/weapon/other.yaml", "portable/genshin/resources",
      `${wish}/data`, `${wish}/resources`,
      "portable/zzz/config/alias.yaml",
      "portable/zzz/config/rank.yaml", paths.LOTUS_ZZZ_PANEL_CONFIG, "portable/zzz/dist/model/damage/character",
      zzz, "themes/challenge", "themes/original",
    ]);
    const moved = await activateUpdate(active, candidate, async (root) => {
      const legacyPool = createWishPoolSource({ legacyDirectory: join(root, wish), bannerFile: "" });
      expect((await legacyPool("role", 0, "42"))?.up5).toEqual([{ name: "菲林斯", type: "role" }]);
      const aliases = await readZzzRoleAliases(join(root, zzz));
      expect(zzzRoleAlias(aliases, "隔离鲨鱼")).toBe("艾莲");
      expect(await readFile(join(root, paths.LOTUS_ZZZ_PANEL_CONFIG), "utf8")).toBe("interval: 30\n");
      expect(await readFile(join(root, "themes/challenge/floor12.png"), "utf8")).toBe("旧深渊主题");
      expect(await readFile(join(root, "portable/genshin/defSet/role/index.yaml"), "utf8")).toBe("common_chest: 4000\n");
      expect(await readFile(join(root, "portable/genshin/defSet/weapon/other.yaml"), "utf8")).toBe("actWeapon: [铁蜂刺]\n");
    }, selected);
    await expect(verifyMovedRuntimePaths(active, moved.previous, paths)).resolves.toBeUndefined();
    expect(await Bun.file(join(moved.previous, "themes/unused/bg.png")).exists()).toBe(true);
    expect(await Bun.file(join(moved.previous, "portable/genshin/config/role.index.yaml")).exists()).toBe(true);
    expect(await Bun.file(join(moved.previous, "portable/zzz/config/panel.yaml")).exists()).toBe(true);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
