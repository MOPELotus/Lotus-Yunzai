import { readPanelTrialDisplay } from "../lib/panel-trial-display.ts";
import { readLegacyCharacterAliasMode } from "../lib/game-character-aliases.ts";
import { readLegacyPanelRecoveryEnabled } from "../lib/legacy-panel-recovery-flow.ts";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { panelGameSettings } from "../lib/panel-game-settings.ts";
import { panelApi } from "../lib/panel.ts";
import { readGenshinShowcaseServer } from "../plugins/genshin/panel/showcase-config.ts";
import { readGridFightRecentCount } from "../plugins/starrail/grid-fight-config.ts";
import { readShowcaseServer } from "../plugins/starrail/panel-showcase-config.ts";
import { readStarRailOriginalSettings, starRailUsesBuiltInPortrait } from "../plugins/starrail/panel-original-config.ts";

const path = "/panel/api/settings/business/games";
const headers = { Authorization: "Bearer game-panel-test", "Content-Type": "application/json" };
const endpoint = "http://localhost" + path;
type Values = Record<string, string | number | boolean>;
type Result = { readonly fields: readonly { key: string; readonly?: boolean; hint?: string }[]; readonly values: Values };

function send(previous: Values, values: Values) {
  return new Request(endpoint, { method: "PUT", headers, body: JSON.stringify({ previous, values }) });
}

test("游戏展柜和货币战争面板复用真实旧设置，并即刻由现行读取器读回", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-game-settings-"));
  const root = pathToFileURL(directory + "/");
  const env = { gs: Bun.env.LOTUS_GENSHIN_SHOWCASE_SERVER, sr: Bun.env.LOTUS_STAR_RAIL_SHOWCASE_SERVER };
  delete Bun.env.LOTUS_GENSHIN_SHOWCASE_SERVER;
  delete Bun.env.LOTUS_STAR_RAIL_SHOWCASE_SERVER;
  try {
    const config = join(directory, "config", "global.yaml");
    await mkdir(join(directory, "config"));
    await mkdir(join(directory, "plugins/miao-plugin/config"), { recursive: true });
    await mkdir(join(directory, "plugins/xhh/config"), { recursive: true });
    await writeFile(join(directory, "plugins/miao-plugin/config/cfg.js"), "export const srProfileServer = '442';\n");
    await writeFile(join(directory, "plugins/xhh/config/config.yaml"), "huobi_num: 3\n");
    await writeFile(config, "# 保留此注释\ngenshin:\n  unrelated: keep\nstarrail:\n  part: keep\nextra: yes\n");
    const route = panelGameSettings(root, "showcase");
    const panel = panelApi("game-panel-test", [], name => name === path ? route : undefined);
    expect((await panel(new Request(endpoint)))?.status).toBe(401);
    const original = await panel(new Request(endpoint, { headers }));
    const result = await original!.json() as Result;
    expect(result.values).toEqual({ genshinSource: "0", starrailSource: "442", gridFightRecentCount: 3,
      starrailOriginalEnabled: true, starrailOriginalRecall: true, starrailOriginalRecallSeconds: 30, legacyPanelRecovery: false, starrailBuiltInPortraitGroups: "", starrailLegacyAliasMode: 2,
      panelTrialDifference: true, panelTrialLongTitle: 1 });

    const values = { ...result.values, genshinSource: "332", starrailSource: "234", gridFightRecentCount: 1, legacyPanelRecovery: true,
      panelTrialDifference: false, panelTrialLongTitle: 2 };
    expect((await panel(send(result.values, { ...values, genshinSource: "3" })))?.status).toBe(400);
    expect((await panel(send(result.values, { ...values, starrailSource: "1" })))?.status).toBe(400);
    expect((await panel(send(result.values, { ...values, gridFightRecentCount: 4 })))?.status).toBe(400);
    expect((await panel(send(result.values, { ...values, panelTrialDifference: "false" })))?.status).toBe(400);
    expect((await panel(send(result.values, { ...values, panelTrialLongTitle: 3 })))?.status).toBe(400);
    const saved = await panel(send(result.values, values));
    expect(saved?.status).toBe(200);
    expect(await readGenshinShowcaseServer(root)).toBe("332");
    expect(await readShowcaseServer(root)).toBe("234");
    expect(await readGridFightRecentCount(root)).toBe(1);
    expect(await readLegacyPanelRecoveryEnabled(root)).toBe(true);
    expect(await readPanelTrialDisplay(root)).toEqual({ showDifference: false, longTitle: 2 });
    const text = await readFile(config, "utf8");
    expect(text).toContain("# 保留此注释");
    expect(Bun.YAML.parse(text)).toEqual({
      genshin: { unrelated: "keep", showcase_server: "332" },
      starrail: { part: "keep", showcase_server: "234", grid_fight_recent_count: 1 },
      extra: "yes",
      panel_legacy_recovery: true,
      panel_trial: { show_difference: false, long_title: 2 },
    });
    expect((await panel(send(result.values, values)))?.status).toBe(409);
    expect(await readFile(config, "utf8")).toBe(text);
  } finally {
    if (env.gs === undefined) delete Bun.env.LOTUS_GENSHIN_SHOWCASE_SERVER;
    else Bun.env.LOTUS_GENSHIN_SHOWCASE_SERVER = env.gs;
    if (env.sr === undefined) delete Bun.env.LOTUS_STAR_RAIL_SHOWCASE_SERVER;
    else Bun.env.LOTUS_STAR_RAIL_SHOWCASE_SERVER = env.sr;
    await rm(directory, { recursive: true, force: true });
  }
});

test("显式展柜环境覆盖在面板可见但不可改，未覆盖配置仍可写", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-game-override-"));
  const root = pathToFileURL(directory + "/");
  const previousEnv = Bun.env.LOTUS_STAR_RAIL_SHOWCASE_SERVER;
  try {
    Bun.env.LOTUS_STAR_RAIL_SHOWCASE_SERVER = "4";
    const route = panelGameSettings(root, "showcase");
    const result = await (await route(new Request(endpoint), () => true)).json() as Result;
    expect(result).toMatchObject({ values: { starrailSource: "4" } });
    expect(result.fields.find(field => field.key === "starrailSource")).toMatchObject({ readonly: true });
    expect((await route(send(result.values, { ...result.values, starrailSource: "3" }), () => true)).status).toBe(400);
    expect((await route(send(result.values, { ...result.values, gridFightRecentCount: 1 }), () => true)).status).toBe(200);
    expect(await readShowcaseServer(root)).toBe("4");
    expect(await readGridFightRecentCount(root)).toBe(1);
  } finally {
    if (previousEnv === undefined) delete Bun.env.LOTUS_STAR_RAIL_SHOWCASE_SERVER;
    else Bun.env.LOTUS_STAR_RAIL_SHOWCASE_SERVER = previousEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test("面板伤害设置保留原字段和注释，拒绝授权丢失、旧页面和错误值", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-damage-settings-"));
  const root = pathToFileURL(directory + "/");
  try {
    await mkdir(join(directory, "config"));
    const config = join(directory, "config/genshin-damage.yaml");
    const initial = "# 保留不同用途的字段\nengineMode: auto\nextra: { keep: true }\nconscompare: true # 命座对比\n";
    await writeFile(config, initial);
    const route = panelGameSettings(root, "genshin-damage");
    const record = await (await route(new Request(endpoint), () => true)).json() as Result;
    const { values } = record;
    expect(values).toEqual({ engineMode: "auto", lolomicalc: true, lolomiartis: true, templateteam: false, conscompare: true });
    expect(record.fields.every(field => field.hint?.includes("重启"))).toBe(true);
    expect((await route(send(values, { ...values, engineMode: "python" }), () => true)).status).toBe(400);
    const next = { ...values, engineMode: "lolomi", lolomiartis: false, templateteam: true, conscompare: false };
    let checks = 0;
    expect((await route(send(values, next), () => ++checks < 3)).status).toBe(401);
    expect(await readFile(config, "utf8")).toBe(initial);
    expect((await route(send(values, next), () => true)).status).toBe(200);
    expect((await route(send(values, next), () => true)).status).toBe(409);
    const saved = await readFile(config, "utf8");
    expect(saved).toContain("# 保留不同用途的字段");
    expect(saved).toContain("# 命座对比");
    expect(Bun.YAML.parse(saved)).toEqual({
      engineMode: "lolomi", extra: { keep: true }, lolomiartis: false, templateteam: true, conscompare: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("星铁原图设置继承归档，保存覆盖旧值并保留 0 秒", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-starrail-original-"));
  const root = pathToFileURL(directory + "/");
  try {
    const legacyFolder = join(directory, "backup/plugins/StarRail-plugin/config");
    await mkdir(legacyFolder, { recursive: true });
    await writeFile(join(legacyFolder, "PanelSetting.yaml"), "originalPic: false\nbackCalloriginalPic: false\nbackCalloriginalPicTime: 56\nno_profile: [77, \"88\"]\n");
    const route = panelGameSettings(root, "showcase");
    const { values, fields } = await (await route(new Request(endpoint), () => true)).json() as Result;
    expect(values).toMatchObject({ starrailOriginalEnabled: false, starrailOriginalRecall: false, starrailOriginalRecallSeconds: 56,
      starrailBuiltInPortraitGroups: "77, 88" });
    expect(fields.find(field => field.key === "starrailOriginalRecallSeconds")).toMatchObject({ type: "number", min: 0, max: 120 });
    expect(await starRailUsesBuiltInPortrait({ message_type: "group", group_id: 77 }, root)).toBe(true);
    expect(await starRailUsesBuiltInPortrait({ message_type: "group", group_id: 89 }, root)).toBe(false);
    expect(await starRailUsesBuiltInPortrait({ message_type: "private", group_id: 77 }, root)).toBe(false);
    const next = { ...values, starrailOriginalEnabled: true, starrailOriginalRecall: true, starrailOriginalRecallSeconds: 0,
      starrailBuiltInPortraitGroups: "" };
    expect((await route(send(values, { ...next, starrailBuiltInPortraitGroups: "77, -1" }), () => true)).status).toBe(400);
    expect((await route(send(values, { ...next, starrailOriginalEnabled: 1 }), () => true)).status).toBe(400);
    expect((await route(send(values, { ...next, starrailOriginalRecallSeconds: 121 }), () => true)).status).toBe(400);
    expect((await route(send(values, next), () => true)).status).toBe(200);
    expect(await readStarRailOriginalSettings(root)).toEqual({ starrailOriginalEnabled: true, starrailOriginalRecall: true, starrailOriginalRecallSeconds: 0 });
    expect(Bun.YAML.parse(await readFile(join(directory, "config/global.yaml"), "utf8"))).toEqual({
      starrail: { original_pic: true, back_call_original_pic: true, back_call_original_pic_time: 0, built_in_portrait_groups: [] },
    });
    expect(await starRailUsesBuiltInPortrait({ message_type: "group", group_id: 77 }, root)).toBe(false);
    expect((await route(send(next, { ...next, starrailBuiltInPortraitGroups: "90，91, 90" }), () => true)).status).toBe(200);
    expect(await starRailUsesBuiltInPortrait({ message_type: "group", group_id: 90 }, root)).toBe(true);
    expect(await starRailUsesBuiltInPortrait({ message_type: "group", group_id: 88 }, root)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("星铁面板查询旧别名权限，保存现代覆盖后聊天实时读取", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-panel-starrail-alias-"));
  const root = pathToFileURL(directory + "/");
  const old = join(directory, "backup/plugins/StarRail-plugin/config");
  const config = join(directory, "config/global.yaml");
  try {
    await mkdir(old, { recursive: true });
    await mkdir(join(directory, "config"));
    await writeFile(join(old, "gachaHelp.yaml"), "abbrSetAuth: 1\n");
    await writeFile(config, "# 现有配置\nstarrail: {original_pic: true}\n");
    const route = panelGameSettings(root, "showcase");
    const panel = panelApi("game-panel-test", [], name => name === path ? route : undefined);
    const { fields, values } = await (await panel(new Request(endpoint, { headers })))!.json() as Result;
    expect(fields.find(field => field.key === "starrailLegacyAliasMode")).toMatchObject({ type: "select",
      options: [{ label: "仅机器人主人", value: 2 }, { label: "本群群主和管理员", value: 1 }, { label: "本群成员", value: 0 }],
    });
    expect(values.starrailLegacyAliasMode).toBe(1);
    for (const invalid of [3, -1, "0", false]) {
      expect((await panel(send(values, { ...values, starrailLegacyAliasMode: invalid })))?.status).toBe(400);
    }
    const next = { ...values, starrailLegacyAliasMode: 0 };
    let calls = 0;
    expect((await route(send(values, next), () => ++calls < 3)).status).toBe(401);
    expect(await readLegacyCharacterAliasMode("sr", directory)).toBe(1);
    expect((await panel(send(values, next)))?.status).toBe(200);
    expect(await readLegacyCharacterAliasMode("sr", directory)).toBe(0);
    expect(await readLegacyCharacterAliasMode("gs", directory)).toBe(2);
    expect((await panel(send(values, next)))?.status).toBe(409);
    expect(await readFile(join(old, "gachaHelp.yaml"), "utf8")).toBe("abbrSetAuth: 1\n");
    expect(Bun.YAML.parse(await readFile(config, "utf8"))).toEqual({
      starrail: { original_pic: true, legacy_alias_group_permission: 0 },
    });
    await writeFile(config, "starrail: {legacy_alias_group_permission: invalid}\n");
    expect(await readLegacyCharacterAliasMode("sr", directory)).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
