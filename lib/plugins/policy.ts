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
  { names: ["fansky_qs", "tianru-plugin", "nwflower/atlas", "atlas-plugin", "achievements-plugin", "liangshi-calc"],
    replacement: "atlas" },
  { names: ["mora-plugin"], replacement: "guides 和游戏模块" },
  { names: ["xiaoyao-cvs-plugin", "device-plugin", "lovemys", "axiu-plugin", "bujidao",
    "bujidaorun", "trss-plugin", "xhh-tl"], replacement: "公共账号服务和游戏模块" },
  { names: ["guoba-plugin"], replacement: "panel" },
  { names: ["yenai-plugin", "earth-k-plugin"], replacement: "group 和 system" },
  { names: ["notice-plugin"], replacement: "notice" },
  { names: ["meme-plugin"], replacement: "meme" },
  { names: ["rconsole-plugin", "xiaofei-plugin", "xhh", "yuki-plugin"], replacement: "media" },
  { names: ["flower-plugin"], replacement: "各游戏模块的模拟抽卡" },
  { names: ["lotus-plugin", "lotus-refactor"], replacement: "Lotus-Yunzai 的各功能模块" },
];

const kuroSignInNames = ["a-game_checkin", "a-game-checkin", "yoshino-xiao7/a-game_checkin", "yunzai-kuro-plugin",
  "tomyjan/yunzai-kuro-plugin"] as const;

const kuroGames = [
  {
    title: "鸣潮",
    games: ["鸣潮", "鳴潮", "wutheringwaves", "wuwa"],
    names: ["waves-plugin", "erzaozi/waves-plugin", "kagura-wei/waves-plugin", "ams-plugin", "tyql688/ams-plugin",
      "kuromc-plugin", "loneyclown/kuromc-plugin", "wuwa-panel", "syasaki77/wuwa-panel", "gamepush-plugin",
      "liulian-plugin", "wutheringwavesuid", "xutheringwavesuid", "wavesgachasim", "gutools",
      "mcbq-plugin", "mingchaobq-plugin", "xh2580/mingchaobq-plugin", ...kuroSignInNames],
  },
  {
    title: "战双帕弥什",
    games: ["战双", "戰雙", "战双帕弥什", "戰雙帕彌什", "punishinggrayraven", "pgr", "pns"],
    names: ["pgruid", "loping151/pgruid", "pgrgachasim", "xbaiyz12/pgrgachasim", ...kuroSignInNames],
  },
  {
    title: "战场双马尾",
    games: ["战场双马尾", "戰場雙馬尾", "戦場ツインテール", "twintailsbattleground", "twintailbattleground"],
    names: [],
  },
  {
    title: "库洛游戏",
    games: ["库洛游戏", "庫洛遊戲", "kurogames"],
    names: ["gs_kuro_cos", "mimokit/gs_kuro_cos", "concywee/nonebot-plugin-kurogames"],
  },
] as const;

function gameKey(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[\s_.:·\-]+/gu, "");
}

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
  const rule = merged.find(({ names: candidates }) => candidates.some((name) => names.includes(name)));
  if (rule) {
    return `旧插件功能已归并，请使用 ${rule.replacement}。`;
  }
  const declaredGames = games.map(gameKey);
  const matched = kuroGames.filter(game =>
    game.names.some(name => names.includes(name)) || game.games.some(name => declaredGames.includes(name)));
  if (matched.length) {
    return `包含${matched.map(({ title }) => title).join("、")}功能，Lotus-Yunzai 不加载该插件。`;
  }
}
