import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { characterAliasKey, readGameCharacterAliases } from "../lib/game-character-aliases.ts";
import { readPanelTheme } from "../plugins/genshin/panel/theme.ts";
import { matchGenshinPanel, selectAvatar, type PanelAvatar, type PanelSnapshot } from "../plugins/genshin/panel/model.ts";
import { findPanelAvatar, readTheme } from "../plugins/starrail/panel-card.ts";
import { readZzzAliasRegistry, zzzRoleAlias } from "../plugins/atlas/zzz-aliases.ts";
import { readZzzRoleAliases } from "../plugins/zzz/role-alias.ts";
import { zzzResourceDirectory } from "../plugins/zzz/card-theme.ts";

test("当前内置Miao别名同时进入原神面板与伤害选择、星铁普通与加强角色选择", async () => {
  const [gs, sr] = await Promise.all([readPanelTheme(), readTheme()]);
  const father = { id: 10000096, name: "阿蕾奇诺" } as PanelAvatar;
  const snapshot = { avatars: { [father.id]: father } } as PanelSnapshot;
  for (const text of ["#仆人面板", "#仆人伤害", "#Arlecchino面板", "#父亲伤害"]) {
    const command = matchGenshinPanel(text);
    expect(command).toBeDefined();
    expect(selectAvatar(snapshot, command!.name!, gs)).toBe(father);
  }
  type Avatar = Parameters<typeof findPanelAvatar>[0][number];
  const actors = [["1204", "景元"], ["1213", "丹恒•饮月"], ["1308", "黄泉"], ["1205", "刃"], ["2205", "刃Pro"]]
    .map(([id, name]) => ({ id, name }) as Avatar);
  for (const [alias, id] of [["神君发射器", "1204"], ["龙尊", "1213"], ["雷电芽衣", "1308"], ["加强版刃", "2205"], ["刃", "1205"]]) {
    expect(findPanelAvatar(actors, alias!, sr)?.id).toBe(id!);
  }
});

test("冷根使用当前alias.js及角色index别名，自定义覆盖而正式名与歧义保持安全", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-current-alias-"));
  try {
    const source = join(root, "resources/builtin/games/miao/meta-sr/character");
    const config = join(root, "config/character-aliases");
    await mkdir(source, { recursive: true });
    await mkdir(config, { recursive: true });
    await writeFile(join(source, "alias.js"), 'export const alias = { "景元": "新增别名,共同别名", "黄泉": "共同别名" };');
    await writeFile(join(source, "data.json"), JSON.stringify({ 1204: { name: "景元" }, 1308: { name: "黄泉" }, 2205: { name: "刃Pro", alias: "加强版刃", abbr: "刃加强版" } }));
    await writeFile(join(config, "alias_sr.cfg"), "黄泉：新增别名，景元，个人别名\n");
    const aliases = await readGameCharacterAliases("sr", root, { includePreset: true });
    expect(aliases.get(characterAliasKey("新增别名"))).toBe("黄泉");
    expect(aliases.get(characterAliasKey("景元"))).toBe("景元");
    expect(aliases.get(characterAliasKey("加强版刃"))).toBe("刃Pro");
    expect(aliases.get(characterAliasKey("刃加强版"))).toBe("刃Pro");
    expect(aliases.has(characterAliasKey("共同别名"))).toBe(false);
    expect(aliases.get(characterAliasKey("个人别名"))).toBe("黄泉");
    expect((await readGameCharacterAliases("sr", root)).has(characterAliasKey("加强版刃"))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("绝区零冷安装默认别名与面板消费者共用同一源，艾莲别名可对应实际角色ID", async () => {
  const resources = zzzResourceDirectory();
  const [registry, aliases, raw] = await Promise.all([
    readZzzAliasRegistry(undefined), readZzzRoleAliases(resources),
    Bun.file(join(resources, "map/PartnerId2Data.json")).json() as Promise<Record<string, { name: string; full_name: string }>>,
  ]);
  for (const query of ["爱莲", "艾莲乔", "鲨鱼妹", "艾莲·乔"]) {
    expect(zzzRoleAlias(registry.groups, query)).toBe("艾莲");
    const canonical = zzzRoleAlias(aliases, query);
    expect(canonical).toBe("艾莲");
    expect(Object.entries(raw).find(([, row]) => row.name === canonical)?.[0]).toBe("1191");
  }
});
