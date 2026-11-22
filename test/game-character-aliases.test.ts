import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { createGameCharacterAliasCommands, matchGameCharacterAliasCommand, readGameCharacterAliases } from "../lib/game-character-aliases.ts";
import { selectAvatar, type PanelAvatar, type PanelCatalog, type PanelSnapshot } from "../plugins/genshin/panel/model.ts";
import { findPanelAvatar } from "../plugins/starrail/panel-card.ts";

test("Genshin and Star Rail character aliases read archived data, preserve concurrent changes, and resolve panel queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-role-aliases-"));
  try {
    const legacyDir = join(root, "backup/plugins/miao-plugin/config");
    const legacyGs = join(legacyDir, "alias_gs.cfg");
    const gsSource = "# comment\n芙宁娜：剧团队长，水舞演员\n水神:剧团队长\n";
    await mkdir(dirname(legacyGs), { recursive: true });
    await writeFile(legacyGs, gsSource);
    await writeFile(join(legacyDir, "alias_sr.cfg"), "希儿：剧团队长，小蝴蝶\n");
    const run = createGameCharacterAliasCommands(lockFile, new AbortController().signal, root);
    const owner = { user_id: 1, isBotMaster: (user: number) => user === 1 };
    const execute = (message: string, context: Parameters<typeof run>[1] = owner) => {
      const command = matchGameCharacterAliasCommand(message);
      expect(command).toBeDefined();
      return run(command!, context);
    };
    expect(await execute("#别名列表", {})).toContain("【星铁自定义别名】");
    expect(await execute("#别名删除 剧团队长")).toContain("多个匹配");
    expect(await execute("#别名原神删除 剧团队长", { ...owner, user_id: 2 })).toContain("主人");
    expect(await execute("#别名原神删除 剧团队长", { ...owner, isDelegated: true })).toBeUndefined();
    expect(await execute("#别名原神删除 剧团队长")).toContain("已删除");
    expect(await readFile(legacyGs, "utf8")).toBe(gsSource);
    expect(await readGameCharacterAliases("gs", root)).toEqual(new Map([["水舞演员", "芙宁娜"]]));
    expect(await readGameCharacterAliases("sr", root)).toEqual(new Map([["剧团队长", "希儿"], ["小蝴蝶", "希儿"]]));
    expect(await execute("*别名设置 希儿 小蝴蝶")).toContain("已存在");
    expect(await execute("*别名设置 不存在的角色 小白鹅")).toContain("未找到该角色");
    expect(await execute("*别名设置 希儿 １２３")).toContain("不能是纯数字");
    const [first, second] = await Promise.all([
      execute("#星铁别名设置 希儿 夜班花匠"), execute("#别名星铁设置 小蝴蝶 蓝线快递员"),
    ]);
    expect(first).toContain("已添加");
    expect(second).toContain("已添加");

    const gsAvatar = { id: 10000089, name: "芙宁娜" } as PanelAvatar;
    const gsSnapshot = { avatars: { [gsAvatar.id]: gsAvatar } } as PanelSnapshot;
    const gsCatalog: PanelCatalog = {
      characters: {}, artifacts: new Map(), artifactSets: new Map(), customAliases: await readGameCharacterAliases("gs", root),
    };
    expect(selectAvatar(gsSnapshot, "水舞演员", gsCatalog)).toBe(gsAvatar);
    const srAvatar = { id: "1102", name: "希儿" } as Parameters<typeof findPanelAvatar>[0][number];
    const srTheme = { characters: {}, customAliases: await readGameCharacterAliases("sr", root) } as Parameters<typeof findPanelAvatar>[2];
    expect(findPanelAvatar([srAvatar], "夜班花匠", srTheme)).toBe(srAvatar);
    expect(findPanelAvatar([srAvatar], "蓝线快递员", srTheme)).toBe(srAvatar);
    expect(await execute("#别名原神删除 水舞演员")).toContain("已删除");
    expect(await readGameCharacterAliases("gs", root)).toEqual(new Map());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
