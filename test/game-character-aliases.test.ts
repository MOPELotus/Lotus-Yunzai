import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { createGameCharacterAliasCommands, matchGameCharacterAliasCommand, readGameCharacterAliases } from "../lib/game-character-aliases.ts";
import { legacyCharacterAliasCommands } from "../lib/legacy-character-alias-command.ts";
import { CommandRegistry } from "../lib/commands.ts";
import { normalizeGameCommand } from "../lib/command-prefix.ts";
import type { MessageEvent } from "../lib/messages.ts";
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

test("旧昵称归档与已编辑的别名库合并，两游戏正确解析且移除后不复活", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-legacy-nickname-archive-"));
  const archive = join(root, "backup/plugins/genshin/config");
  const aliasRoot = join(root, "config/character-aliases");
  const gs = join(aliasRoot, "alias_gs.cfg");
  const sr = join(aliasRoot, "alias_sr.cfg");
  const stored = "芙宁娜:\n  - 剧院副手\n  - 旧小狐\n  - 42\n希儿:\n  - 古旧花蝴蝶\n未知角色:\n  - 乱入条目\n";
  try {
    await Promise.all([mkdir(archive, { recursive: true }), mkdir(aliasRoot, { recursive: true })]);
    await Promise.all([writeFile(join(archive, "role.name.yaml"), "芙宁娜: ["), writeFile(gs, "芙宁娜：现代舞小生\n")]);
    expect(await readGameCharacterAliases("gs", root)).toEqual(new Map([["现代舞小生", "芙宁娜"]]));
    await writeFile(join(archive, "role.name.yaml"), stored);
    expect(await readGameCharacterAliases("gs", root)).toEqual(new Map([
      ["现代舞小生", "芙宁娜"], ["剧院副手", "芙宁娜"], ["旧小狐", "芙宁娜"],
    ]));
    expect(await readGameCharacterAliases("sr", root)).toEqual(new Map([["古旧花蝴蝶", "希儿"]]));
    const run = createGameCharacterAliasCommands(lockFile, new AbortController().signal, root);
    const owner = { user_id: 42, isBotMaster: () => true };
    expect(await run(matchGameCharacterAliasCommand("#别名原神删除 旧小狐")!, owner)).toContain("已删除");
    expect(await readGameCharacterAliases("gs", root)).toEqual(new Map([["现代舞小生", "芙宁娜"], ["剧院副手", "芙宁娜"]]));
    expect(await run(matchGameCharacterAliasCommand("*别名设置 希儿 现代邮差")!, owner)).toContain("已添加");
    expect(await readFile(sr, "utf8")).toContain("现代邮差");
    expect(await readFile(join(archive, "role.name.yaml"), "utf8")).toBe(stored);
    await writeFile(join(archive, "role.name.yaml"), "芙宁娜: [旧小狐]\n");
    expect(await readGameCharacterAliases("gs", root)).toEqual(new Map([["现代舞小生", "芙宁娜"], ["剧院副手", "芙宁娜"]]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("旧原神星铁昵称通过宿主分派续接同会话，按当前权限增删并保留其他功能", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-legacy-nickname-dispatch-"));
  const archive = join(root, "backup/plugins/genshin/config");
  const config = join(archive, "mys.set.yaml");
  const groupConnection = new AbortController();
  const otherConnection = new AbortController();
  const friendConnection = new AbortController();
  const lifecycle = new AbortController();
  const registry = new CommandRegistry();
  registry.registerModule(legacyCharacterAliasCommands(lockFile, lifecycle.signal, root));
  registry.registerModule({ name: "fixture-other", commands: {}, fallback: (msg) => msg === "#状态" ? "状态消息" : undefined });
  let administrator = false;
  const owner = (qq: number) => qq === 42;
  const event = (message: string, extras: Partial<MessageEvent> = {}) => ({
    msg: message, raw_message: message, message, post_type: "message", message_type: "group",
    isGroup: true, isPrivate: false, isMaster: false, self_id: 99, user_id: 7, group_id: 77,
    groupActivitySignal: groupConnection.signal,
    listCurrentGroupMembers: async () => [7, 42, 99].map(id => ({ id })),
    groupActivityRoster: async () => [7, 99].map(userId => ({ userId, role: userId === 7 && administrator ? "admin" : "member",
      joinTime: 1, lastSentTime: 1 })),
    reply: () => true, ...extras,
  } satisfies MessageEvent);
  const route = (message: string, extras?: Partial<MessageEvent>, blocked?: string) => {
    const request = event(message, extras);
    return registry.dispatchFallback(request, names => !blocked || !names.includes(blocked), owner, normalizeGameCommand(request).msg);
  };
  try {
    await mkdir(archive, { recursive: true });
    const defaults = join(archive, "../defSet/role");
    await mkdir(defaults, { recursive: true });
    await writeFile(join(defaults, "name.yaml"), "10000089: [芙宁娜, 水的女儿]\n");
    await writeFile(join(archive, "role.name.yaml"), "芙宁娜: [旧小狐]\n希儿: [旧电报员]\n");
    await writeFile(config, "abbrSetAuth: 0\n");
    expect(await route("#设置芙宁娜别名")).toContain("请发送芙宁娜别名");
    expect(await route("#状态")).toBe("状态消息");
    expect(await route("片场副导演", { user_id: 42 })).toBeUndefined();
    expect(await route("片场副导演", { group_id: 78 })).toBeUndefined();
    expect(await route("片场副导演", { self_id: 100 })).toBeUndefined();
    expect(await route("片场副导演", { groupActivitySignal: otherConnection.signal })).toBeUndefined();
    expect(await route("片场副导演", { isDelegated: true })).toBeUndefined();
    expect(await route("片场副导演", {}, "[genshin] 角色别名")).toBeUndefined();
    expect(await route("片场副导演 片场摄影师 片场副导演")).toBe("设置别名成功：片场副导演、片场摄影师");
    expect(await route("#芙宁娜昵称")).toMatchObject({ type: "forward", nodes: [expect.stringContaining("片场摄影师")] });
    expect(await route("#水的女儿昵称")).toMatchObject({ type: "forward", nodes: [expect.stringContaining("水的女儿")] });
    expect(await route("#删除昵称水的女儿")).toContain("默认别名");
    expect(await route("#删除昵称旧小狐")).toBe("删除芙宁娜别名成功：旧小狐");
    expect(await route("#芙宁娜昵称")).toMatchObject({ type: "forward", nodes: [expect.not.stringContaining("旧小狐")] });

    const run = createGameCharacterAliasCommands(lockFile, lifecycle.signal, root);
    await run(matchGameCharacterAliasCommand("#别名原神设置 芙宁娜 主人演员")!, { user_id: 42, isBotMaster: owner });
    expect(await route("#删除昵称主人演员")).toContain("仅限本机器人主人");
    expect(await route("#删除昵称主人演员", { user_id: 42 })).toContain("删除芙宁娜别名成功");

    await writeFile(config, "abbrSetAuth: 1\n");
    expect(await route("#星铁设置希儿别名")).toContain("暂无权限");
    administrator = true;
    expect(await route("*配置希儿昵称")).toContain("请发送希儿别名");
    administrator = false;
    expect(await route("越权新邮差")).toContain("暂无权限");
    expect((await readGameCharacterAliases("sr", root)).has("越权新邮差")).toBe(false);

    const privateFriend = { message_type: "private", isGroup: false, isPrivate: true, group_id: undefined,
      privateCredentialSignal: friendConnection.signal, adapter: "milky" } satisfies Partial<MessageEvent>;
    expect(await route("*设置希儿昵称", privateFriend)).toContain("暂无权限");
    const privateOwner = { ...privateFriend, user_id: 42 };
    expect(await route("*设置希儿昵称", privateOwner)).toContain("请发送希儿别名");
    expect(await route("#取消设置昵称", privateOwner)).toContain("已取消");
    expect(await route("取消后候选", privateOwner)).toBeUndefined();
    expect(await route("#星铁设置希儿别名", privateOwner)).toContain("请发送希儿别名");
    expect(await route("月台小邮差", privateOwner)).toBe("设置别名成功：月台小邮差");
    expect(await route("#星铁希儿昵称", privateOwner)).toMatchObject({ type: "forward", nodes: [expect.stringContaining("旧电报员")] });
    expect(await route("#星铁设置希儿别名", privateOwner)).toContain("请发送希儿别名");
    friendConnection.abort();
    expect(await route("断线后候选", privateOwner)).toBeUndefined();
  } finally {
    lifecycle.abort();
    groupConnection.abort();
    otherConnection.abort();
    friendConnection.abort();
    await rm(root, { recursive: true, force: true });
  }
});
