import { dirname, join } from "node:path";

// These overrides are read as-is by their modules, including spaces in local paths.
const rawPaths = [
  "LOTUS_ZZZ_LEGACY_DATA_DIR", "LOTUS_ZZZ_LEGACY_HISTORY_DIR", "LOTUS_ZZZ_LEGACY_RESOURCES_DIR",
  "LOTUS_ZZZ_DAMAGE_DATA_DIR", "LOTUS_ZZZ_PANEL_CONFIG", "LOTUS_ZZZ_RANK_CONFIG",
  "LOTUS_SYSTEM_STATUS_CONFIG", "LOTUS_SYSTEM_STATUS_THEME_DIR", "LOTUS_SYSTEM_VERSION_THEME_DIR",
  "LOTUS_NOTICE_SCHEDULE_CONFIG",
] as const;

const trimmedPaths = [
  "LOTUS_GENSHIN_LEGACY_PANEL_DIR", "LOTUS_GENSHIN_PANEL_THEME_DIR", "LOTUS_GENSHIN_GACHA_THEME_DIR",
  "LOTUS_GENSHIN_GACHA_RESOURCES_DIR", "LOTUS_GENSHIN_WISH_POOL_FILE", "LOTUS_GENSHIN_WISH_COIN_FILE", "LOTUS_GENSHIN_WISH_RECALL_FILE",
  "LOTUS_GENSHIN_DAMAGE_CONFIG",
  "LOTUS_GENSHIN_WISH_THEME_DIR", "LOTUS_GENSHIN_WISH_ELEMENTS_DIR", "LOTUS_STAR_RAIL_LEGACY_PANEL_DIR",
  "LOTUS_STAR_RAIL_PANEL_THEME_DIR", "LOTUS_STAR_RAIL_GACHA_THEME_DIR", "LOTUS_STAR_RAIL_GACHA_GENSHIN_RESOURCES_DIR",
  "LOTUS_STAR_RAIL_WARP_THEME_DIR",
  "LOTUS_STAR_RAIL_CHALLENGE_THEME_DIR", "LOTUS_ZZZ_GACHA_THEME_DIR", "LOTUS_ZZZ_CALENDAR_THEME_DIR",
  "LOTUS_GUIDES_TEAM_DIR", "LOTUS_GUIDES_MORA_PACK_DIR", "LOTUS_GUIDES_ROLE_CONFIG_DIR", "LOTUS_GUIDES_LEGACY_ATLAS_DIR",
  "LOTUS_GROUP_LIKE_ASSETS_DIR", "LOTUS_GROUP_NOTICE_THEME_DIR",
] as const;

export const gameResourcePathKeys = [
  ...rawPaths, ...trimmedPaths, "LOTUS_GENSHIN_RANK_THEME_DIR", "LOTUS_GENSHIN_ARK_THEME_DIR",
  "LOTUS_STAR_RAIL_RANK_THEME_DIR", "LOTUS_STAR_RAIL_ARK_THEME_DIR", "LOTUS_GENSHIN_WISH_LEGACY_DIR", "LOTUS_GENSHIN_WISH_FLOWER_DIR",
] as const;

export function configuredGameResourcePaths(env: Readonly<Record<string, string | undefined>>): string[] {
  const paths = [
    ...rawPaths.map(key => env[key]), ...trimmedPaths.map(key => env[key]?.trim()),
    env.LOTUS_GENSHIN_RANK_THEME_DIR?.trim() || env.LOTUS_GENSHIN_ARK_THEME_DIR?.trim(),
    env.LOTUS_STAR_RAIL_RANK_THEME_DIR?.trim() || env.LOTUS_STAR_RAIL_ARK_THEME_DIR?.trim(),
  ];

  const resources = env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR;
  if (resources) {
    const plugin = dirname(resources);
    paths.push(join(plugin, "config", "alias.yaml"));
    if (!env.LOTUS_ZZZ_PANEL_CONFIG) paths.push(join(plugin, "config", "panel.yaml"));
    if (!env.LOTUS_ZZZ_RANK_CONFIG) paths.push(join(plugin, "config", "rank.yaml"));
    if (!env.LOTUS_ZZZ_DAMAGE_DATA_DIR) paths.push(join(plugin, "dist", "model", "damage", "character"));
  }

  const wish = env.LOTUS_GENSHIN_WISH_LEGACY_DIR?.trim() || env.LOTUS_GENSHIN_WISH_FLOWER_DIR?.trim();
  if (wish) {
    if (!env.LOTUS_GENSHIN_WISH_RECALL_FILE?.trim()) paths.push(join(wish, "../../../genshin/config/gacha.set.yaml"));
    paths.push(join(wish, "config", "gacha.yaml"), join(wish, "def", "gacha.yaml"));
    if (!env.LOTUS_GENSHIN_WISH_POOL_FILE?.trim()) {
      paths.push(join(wish, "config", "pool.yaml"), join(wish, "def", "pool.yaml"), join(wish, "data"));
    }
    if (!env.LOTUS_GENSHIN_WISH_COIN_FILE?.trim()) {
      paths.push(join(wish, "config", "coin.yaml"), join(wish, "def", "coin.yaml"));
    }
    if (!env.LOTUS_GENSHIN_WISH_THEME_DIR?.trim()) paths.push(join(wish, "resources"));
    if (!env.LOTUS_GENSHIN_WISH_ELEMENTS_DIR?.trim()) {
      const element = join(wish, "../../..", "genshin", "defSet", "element");
      paths.push(join(element, "role.yaml"), join(element, "weapon.yaml"));
    }
  }
  return paths.filter((path): path is string => !!path);
}
