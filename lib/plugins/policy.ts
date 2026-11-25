import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
interface Rule {
  readonly names: readonly string[];
  readonly replacement: string;
}

const merged: readonly Rule[] = [
  { names: ["yunzai-genshin", "kissnavel/genshin", "miao-plugin"], replacement: $t("lib.plugins.policy.text_b2b35960a4") },
  { names: ["starrail-plugin"], replacement: "starrail" },
  { names: ["zzz-plugin"], replacement: "zzz" },
  { names: ["ark-plugin"], replacement: $t("lib.plugins.policy.text_b2b35960a4") },
  { names: ["lolomi-calc"], replacement: "genshin" },
  { names: ["fansky_qs", "tianru-plugin", "nwflower/atlas", "atlas-plugin", "achievements-plugin", "liangshi-calc"],
    replacement: "atlas" },
  { names: ["mora-plugin"], replacement: $t("lib.plugins.policy.text_6644cd4e3f") },
  { names: ["xiaoyao-cvs-plugin", "device-plugin", "lovemys", "axiu-plugin", "bujidao",
    "bujidaorun", "trss-plugin", "xhh-tl"], replacement: $t("lib.plugins.policy.text_c3b2aed38a") },
  { names: ["guoba-plugin"], replacement: "panel" },
  { names: ["yenai-plugin", "earth-k-plugin"], replacement: $t("lib.plugins.policy.text_09087ef608") },
  { names: ["notice-plugin"], replacement: "notice" },
  { names: ["meme-plugin"], replacement: "meme" },
  { names: ["rconsole-plugin", "xiaofei-plugin", "xhh", "yuki-plugin"], replacement: "media" },
  { names: ["flower-plugin"], replacement: $t("lib.plugins.policy.text_40b361bce6") },
  { names: ["lotus-plugin", "lotus-refactor"], replacement: $t("lib.plugins.policy.text_c725cdb17e") },
];

const kuroSignInNames = ["a-game_checkin", "a-game-checkin", "yoshino-xiao7/a-game_checkin", "yunzai-kuro-plugin",
  "tomyjan/yunzai-kuro-plugin"] as const;

const kuroGames = [
  {
    title: $t("lib.plugins.policy.text_b9d21efb6e"),
    games: [$t("lib.plugins.policy.text_b9d21efb6e"), $t("lib.plugins.policy.text_7ffc8996bf"), "wutheringwaves", "wuwa"],
    names: ["waves-plugin", "erzaozi/waves-plugin", "kagura-wei/waves-plugin", "ams-plugin", "tyql688/ams-plugin",
      "kuromc-plugin", "loneyclown/kuromc-plugin", "wuwa-panel", "syasaki77/wuwa-panel", "gamepush-plugin",
      "liulian-plugin", "wutheringwavesuid", "xutheringwavesuid", "wavesgachasim", "gutools",
      "mcbq-plugin", "mingchaobq-plugin", "xh2580/mingchaobq-plugin", ...kuroSignInNames],
  },
  {
    title: $t("lib.plugins.policy.text_bf9f35196b"),
    games: [$t("lib.plugins.policy.text_c9d1ffe8c8"), $t("lib.plugins.policy.text_e7f1cf8a85"), $t("lib.plugins.policy.text_bf9f35196b"), $t("lib.plugins.policy.text_572bb52641"), "punishinggrayraven", "pgr", "pns"],
    names: ["pgruid", "loping151/pgruid", "pgrgachasim", "xbaiyz12/pgrgachasim", ...kuroSignInNames],
  },
  {
    title: $t("lib.plugins.policy.text_77e3f7c087"),
    games: [$t("lib.plugins.policy.text_77e3f7c087"), $t("lib.plugins.policy.text_83e1f40bcf"), $t("lib.plugins.policy.text_c4210c634f"), "twintailsbattleground", "twintailbattleground"],
    names: [],
  },
  {
    title: $t("lib.plugins.policy.text_19e053be48"),
    games: [$t("lib.plugins.policy.text_19e053be48"), $t("lib.plugins.policy.text_c15d699bb8"), "kurogames"],
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
    return $t("lib.plugins.policy.text_86babfebc9", { "replacement": rule.replacement });
  }
  const declaredGames = games.map(gameKey);
  const matched = kuroGames.filter(game =>
    game.names.some(name => names.includes(name)) || game.games.some(name => declaredGames.includes(name)));
  if (matched.length) {
    return $t("lib.plugins.policy.text_e6719ed747", { "value1": matched.map(({ title }) => title).join("、") });
  }
}
