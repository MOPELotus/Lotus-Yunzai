interface Rule {
  readonly names: readonly string[];
  readonly replacement: string;
}

const merged: readonly Rule[] = [
  { names: ["yunzai-genshin", "kissnavel/genshin", "miao-plugin"], replacement: "genshin 和 starrail" },
  { names: ["starrail-plugin"], replacement: "starrail" },
  { names: ["zzz-plugin"], replacement: "zzz" },
  { names: ["ark-plugin"], replacement: "genshin 和 starrail" },
  { names: ["lolomi-calc"], replacement: "genshin" },
  { names: ["fansky_qs", "tianru-plugin", "nwflower/atlas", "atlas-plugin", "achievements-plugin"],
    replacement: "atlas" },
  { names: ["mora-plugin"], replacement: "guides 和游戏模块" },
  { names: ["calendar-plugin"], replacement: "游戏模块" },
  { names: ["xiaoyao-cvs-plugin", "device-plugin", "lovemys", "axiu-plugin", "bujidao",
    "bujidaorun", "trss-plugin"], replacement: "公共账号服务和游戏模块" },
  { names: ["guoba-plugin"], replacement: "panel" },
  { names: ["yenai-plugin", "earth-k-plugin"], replacement: "group 和 system" },
  { names: ["notice-plugin"], replacement: "notice" },
  { names: ["meme-plugin"], replacement: "meme" },
  { names: ["rconsole-plugin", "xiaofei-plugin", "xhh", "yuki-plugin"], replacement: "media" },
  { names: ["flower-plugin"], replacement: "各游戏模块的模拟抽卡" },
  { names: ["lotus-plugin", "lotus-refactor"], replacement: "Lotus-Yunzai 的各功能模块" },
];

const wuwaNames = new Set([
  "waves-plugin", "yunzai-kuro-plugin", "tyql688/ams-plugin", "kuromc-plugin", "wuwa-panel",
  "liangshi-calc", "gamepush-plugin", "a-game_checkin", "xhh-tl", "liulian-plugin",
]);
const wuwaGames = new Set(["wuthering-waves", "wutheringwaves", "wuwa", "鸣潮"]);

export function repositoryKey(value: string): string | undefined {
  const input = value.trim().replace(/^git\+/i, "");
  const shorthand = /^(?:github:|gitee:)?([\w.-]+\/[\w.-]+)$/i.exec(input);
  const remote = /^[^@\s]+@[^:\s]+:(.+)$/.exec(input);
  let path = shorthand?.[1] ?? remote?.[1];

  if (path === undefined) {
    try {
      const url = new URL(input);
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) {
        return;
      }
      path = url.pathname;
    } catch {
      return;
    }
  }
  const match = /(?:^|\/)([\w.-]+\/[\w.-]+)\/?$/.exec(path);
  return match?.[1]?.replace(/\.git$/i, "").toLowerCase();
}

export function rejectionReason(names: readonly string[], games: readonly string[]): string | undefined {
  if (names.some((name) => wuwaNames.has(name)) ||
      games.some((game) => wuwaGames.has(game.trim().toLowerCase()))) {
    return "包含鸣潮功能，Lotus-Yunzai 不加载该插件。";
  }
  const rule = merged.find(({ names: candidates }) => candidates.some((name) => names.includes(name)));
  if (rule) {
    return `旧插件功能已归并，请使用 ${rule.replacement}。`;
  }
}
