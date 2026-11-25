import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
// Old option names and operators follow e81b5ef:apps/customRank.js. See rank-statistics.LICENSE.
import {
  arkCustomRankSessions, queryArkCustomPanel, queryArkCustomRank, readArkCustomRankToken,
  type ArkCustomRankQuery, type ArkCustomRankRow,
} from "./ark-custom-rank.ts";
import type { CommandReply, MessageFallbackContext } from "./commands.ts";

type Game = ArkCustomRankQuery["game"];
type Metric = ArkCustomRankQuery["metric"];
type Filter = ArkCustomRankQuery["filters"][number];
type RankContext = Partial<Pick<MessageFallbackContext, "self_id" | "user_id" | "group_id" |
  "isDelegated" | "isBotMaster" | "lookupReply" | "reply_id" | "inlineImageByteLimit" | "groupActivitySignal" |
  "privateCredentialSignal">> & { readonly message_type?: string; readonly adapter?: string };
type Character = { readonly id: number; readonly name: string };
export type ArkRankRenderModel = {
  readonly title: string;
  readonly metric: Metric;
  readonly rows: readonly ArkCustomRankRow[];
  readonly filters: string;
  readonly count: number;
};
type Image = { readonly type: "image"; readonly file: Uint8Array };
type RankCommand = ReturnType<typeof matchArkRankCommand>;

const fields = new Set(["level", "promote", "cons", "talent_a", "talent_e", "talent_q", "weapon_level", "weapon_promote",
  "weapon_affix", "dmg_avg", "mark_score", "data_time", "artis_sets", "pos1", "pos2", "pos3", "pos4", "pos5", "pos6"]);
const fieldAliases: Readonly<Record<string, string>> = {
  等级: "level", 突破: "promote", 命座: "cons", 命: "cons", 普攻: "talent_a", 战技: "talent_e", 爆发: "talent_q",
  武器等级: "weapon_level", 武器突破: "weapon_promote", 精炼: "weapon_affix", 伤害: "dmg_avg",
  伤害均值: "dmg_avg", 评分: "mark_score", 圣遗物评分: "mark_score", 圣遗物: "artis_sets", 遗器: "artis_sets", 套装: "artis_sets",
};
const operators = { ">=": 0, "=": 1, "<=": 2, ">": 3, "<": 4, "!=": 5 } as const;
const statAliases: Readonly<Record<string, string>> = {
  生命: "hp", 大生命: "hp", 生命值: "hp", 攻击: "atk", 大攻击: "atk", 攻击力: "atk", 防御: "def", 大防御: "def", 防御力: "def",
  速度: "speed", 暴击: "cpct", 暴击率: "cpct", 爆伤: "cdmg", 暴伤: "cdmg", 暴击伤害: "cdmg", 治疗: "heal", 治疗加成: "heal",
  命中: "effPct", 效果命中: "effPct", 物伤: "phy", 物理: "phy", 物理属性伤害提高: "phy",
  火伤: "fire", 火: "fire", 火属性伤害提高: "fire", 冰伤: "ice", 冰: "ice", 冰属性伤害提高: "ice",
  雷伤: "elec", 雷: "elec", 雷属性伤害提高: "elec", 风伤: "wind", 风: "wind", 风属性伤害提高: "wind",
  量子伤: "quantum", 量子: "quantum", 量子属性伤害提高: "quantum", 虚数伤: "imaginary", 虚数: "imaginary",
  虚数属性伤害提高: "imaginary", 击破: "be", 击破特攻: "be", 充能: "recharge", 能量回复效率: "recharge",
  充能效率: "recharge", 小生命: "hpPlus", 小攻击: "atkPlus",
};
const mainStats = [
  ["hpPlus"], ["atkPlus"], ["hp", "atk", "def", "cpct", "cdmg", "heal", "effPct"], ["hp", "atk", "def", "speed"],
  ["hp", "atk", "def", "phy", "fire", "ice", "elec", "wind", "quantum", "imaginary"], ["be", "recharge", "hp", "atk", "def"],
];

export function matchArkRankCommand(message: string) {
  const prefixed = /^(#(?:原神|星铁)?|\*)\s*((?:ark|自定义|排行).*)$/iu.exec(message);
  if (!prefixed) return;
  const [, prefix, body] = prefixed;
  const game = prefix === "#" ? undefined : prefix === "#原神" ? "gs" : "sr";
  if (/^(?:ark)?自定义(?:排名|排行)帮助$/iu.test(body!)) return { type: "help" as const, game };
  const panel = /^(?:ark获取面板|排行面板)\s*(\d+)$/iu.exec(body!);
  if (panel) return { type: "panel" as const, game, rank: Number(panel[1]) };
  const rank = /^(ark(?:自定义)?|自定义)(.{1,144}?)(伤害|圣遗物|遗器)?(?:排名|排行)(?:\s+([^\r\n]{1,480}))?$/iu.exec(body!);
  if (rank) return {
    type: "rank" as const, game: game ?? (rank[1] === "自定义" ? "gs" : undefined), before: rank[2]!, after: rank[4] ?? "",
    metric: rank[3] && rank[3] !== "伤害" ? "artifacts" as const : "damage" as const,
  };
}

type RankingIntent = Extract<RankCommand, { type: "rank" }>;
const quantityPattern = /^(?:nums|数量)[:：=](\d+)$/iu;
const sortPattern = /^(?:sort|排序)[:：]|^(?:升序|降序|asc|desc)$/iu;

function rankInput(intent: RankingIntent) {
  const tokens = `${intent.before} ${intent.after}`.trim().split(/\s+/u);
  const options = (token: string) => quantityPattern.test(token) || sortPattern.test(token) || /[<>=!]/u.test(token);
  return { name: tokens.filter(token => !options(token)).join(""), options: tokens.filter(options) };
}

export function parseArkRankFilters(intent: RankingIntent, game: Game) {
  const { name, options } = rankInput(intent);
  const filters: Filter[] = [];
  const descriptions: string[] = [];
  let count = 20;
  for (const token of options) {
    const quantity = quantityPattern.exec(token);
    if (quantity) {
      count = Math.max(1, Math.min(50, Number(quantity[1])));
      continue;
    }
    if (sortPattern.test(token)) return $t("lib.ark-custom-rank-command.text_2c37378fe2");
    const filter = /^([\w\p{Script=Han}]+)(>=|<=|!=|>|<|=)(.+)$/u.exec(token);
    if (!filter) return $t("lib.ark-custom-rank-command.text_36b0efc23f");
    const [, alias, operator, raw] = filter as unknown as readonly [string, string, keyof typeof operators, string];
    const slot = /^(?:pos|部位)([1-6])$/iu.exec(alias);
    const field = slot ? "pos" + slot[1] : (Object.hasOwn(fieldAliases, alias) ? fieldAliases[alias]! : alias.toLowerCase());
    if (!fields.has(field) || filters.length >= 16) return $t("lib.ark-custom-rank-command.text_1e19fece35");
    let value: string | number;
    if (slot) {
      if (game !== "sr") return $t("lib.ark-custom-rank-command.text_ece5ef6f34");
      const key = Object.hasOwn(statAliases, raw) ? statAliases[raw]! : raw;
      const id = (mainStats[Number(slot[1]) - 1]?.indexOf(key) ?? -1) + 1;
      if (!id) return $t("lib.ark-custom-rank-command.text_c66784f7f7", { "value1": slot[1] });
      value = id;
    } else if (field === "artis_sets" && !/^\d+$/u.test(raw)) {
      if (!/^[\p{L}\p{N}·・]{1,38}$/u.test(raw)) return $t("lib.ark-custom-rank-command.text_e205ca5e19");
      value = raw;
    } else {
      if (!/^\d+(?:\.\d+)?$/u.test(raw) || !Number.isFinite(Number(raw)) || Math.abs(Number(raw)) > Number.MAX_SAFE_INTEGER) {
        return $t("lib.ark-custom-rank-command.text_3398838ac9", { "alias": alias });
      }
      value = Number(raw);
    }
    filters.push({ field, operator: operators[operator], value });
    descriptions.push(`${alias}${operator}${raw}`);
  }
  if (!name || name.length > 40) return $t("lib.ark-custom-rank-command.text_acae0eec7b");
  return { name, filters, count, filterText: descriptions.join(" ") || $t("lib.ark-custom-rank-command.text_484d556139") };
}

const grades = ["D", "C", "B", "A", "S", "SS", "SSS", "ACE", "MAX"] as const;

export function arkCustomRankGrade(score: number, game: Game) {
  const mean = score / (game === "gs" ? 5 : 6);
  const index = [7, 14, 21, 28, 35, 42, 49, 56, 70].findIndex(edge => mean < edge);
  return grades[index] ?? "MAX";
}

function help(game: Game, advanced: boolean) {
  const prefix = game === "sr" ? "*" : "#";
  const sample = game === "sr" ? $t("lib.ark-custom-rank-command.text_cd224df2bc") : $t("lib.ark-custom-rank-command.text_289bd629bd");
  return [
    $t("lib.ark-custom-rank-command.text_76d4dd539c", { "prefix": prefix, "sample": sample }),
    $t("lib.ark-custom-rank-command.text_4a663f1676", { "prefix": prefix, "sample": sample, "value3": game === "sr" ? $t("lib.ark-custom-rank-command.text_2f2b17beb4") : $t("lib.ark-custom-rank-command.text_fc2ee58f3d") }),
    $t("lib.ark-custom-rank-command.text_dac6420e16"),
    $t("lib.ark-custom-rank-command.text_66f4aa8788", { "prefix": prefix }),
    advanced ? $t("lib.ark-custom-rank-command.text_9b7dd6f5f9") :
      $t("lib.ark-custom-rank-command.text_840987d8d0"),
  ].join("\n");
}

export function createArkRankCommand(game: Game, signal: AbortSignal, {
  resolveCharacter, renderRank, renderPanel,
}: {
  resolveCharacter(name: string): Promise<Character | undefined>;
  renderRank(character: Character, model: ArkRankRenderModel, context: RankContext): Promise<Image>;
  renderPanel(character: Character, uid: string, snapshot: unknown, context: RankContext): Promise<Image | undefined>;
}, {
  fetchRank = queryArkCustomRank, fetchPanel = queryArkCustomPanel, readToken = readArkCustomRankToken, sessions = arkCustomRankSessions,
} = {}) {
  const admittedOwner = (context: RankContext) => context.user_id !== undefined && !context.isDelegated && context.isBotMaster?.(context.user_id) === true;
  const tokenFor = (context: RankContext) => admittedOwner(context) ? readToken() : undefined;
  return async (intent: NonNullable<RankCommand>, context: RankContext): Promise<CommandReply | undefined> => {
    if ((intent.game && intent.game !== game) || signal.aborted) return;
    if (context.isDelegated || !context.self_id || !context.user_id ||
        (context.adapter !== undefined && context.adapter !== "onebot" && context.adapter !== "milky") ||
        (context.message_type !== "group" && context.message_type !== "private")) return $t("lib.ark-custom-rank-command.text_9412ff69ac");
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal;
    if (!connection || connection.aborted) return;
    const active = AbortSignal.any([signal, connection]);

    if (intent.type === "help") {
      const advanced = !!await tokenFor(context);
      return active.aborted ? undefined : help(game, advanced && admittedOwner(context));
    }
    if (intent.type === "panel") {
      const record = sessions.find(context);
      if (record && record.game !== game) return;
      if (!Number.isSafeInteger(intent.rank) || intent.rank < 1 || intent.rank > 20) return $t("lib.ark-custom-rank-command.text_7fb32b802a");
      if (!record || !context.lookupReply) return $t("lib.ark-custom-rank-command.text_8918bb3f0c");
      const index = intent.rank - 1;
      const uid = record.uids[index];
      if (index >= record.count || !uid) return $t("lib.ark-custom-rank-command.text_b6bd852fbc");
      if (record.authorizedBy !== undefined && (!admittedOwner(context) || record.authorizedBy !== context.user_id)) {
        return $t("lib.ark-custom-rank-command.text_71963931ea");
      }
      const token = record.authorizedBy === undefined ? undefined : await tokenFor(context);
      if (record.authorizedBy !== undefined && !token) return $t("lib.ark-custom-rank-command.text_13a7d571fc");
      const quote = await context.lookupReply().catch(() => undefined);
      if (active.aborted) return;
      if (quote?.user_id !== context.self_id || sessions.find(context) !== record) return $t("lib.ark-custom-rank-command.text_e869cbf079");
      if (record.authorizedBy !== undefined && !admittedOwner(context)) return $t("lib.ark-custom-rank-command.text_c09e0c00a9");
      const character = { id: record.characterId, name: record.name };
      const panel = await fetchPanel(record.queryId, index, active, token);
      if (active.aborted || sessions.find(context) !== record) return;
      if (record.authorizedBy !== undefined && !admittedOwner(context)) return $t("lib.ark-custom-rank-command.text_c09e0c00a9");
      if ("message" in panel) return panel.message;
      try {
        const image = await renderPanel(character, uid, panel.snapshot, context);
        if (active.aborted || sessions.find(context) !== record) return;
        if (record.authorizedBy !== undefined && !admittedOwner(context)) return $t("lib.ark-custom-rank-command.text_c09e0c00a9");
        return image ?? $t("lib.ark-custom-rank-command.text_aa55b507af");
      } catch {
        if (!active.aborted) return $t("lib.ark-custom-rank-command.text_a6556564ad");
      }
      return;
    }

    const { name } = rankInput(intent);
    if (!name || name.length > 40) return $t("lib.ark-custom-rank-command.text_acae0eec7b");
    const character = await resolveCharacter(name);
    if (!character) return intent.game ? $t("lib.ark-custom-rank-command.text_b4e643d179") : undefined;
    const parsed = parseArkRankFilters(intent, game);
    if (typeof parsed === "string") return parsed;
    const needsToken = parsed.filters.some(({ field }) => field !== "cons");
    const token = needsToken ? await tokenFor(context) : undefined;
    if (needsToken && (!token || !admittedOwner(context))) return $t("lib.ark-custom-rank-command.text_d9231430ee");
    if (active.aborted) return;
    const result = await fetchRank({ game, characterId: character.id, metric: intent.metric, filters: parsed.filters, count: parsed.count }, active, token);
    if (active.aborted) return;
    if (needsToken && !admittedOwner(context)) return $t("lib.ark-custom-rank-command.text_c09e0c00a9");
    if ("message" in result) return result.message;
    if (!result.rows.length) return $t("lib.ark-custom-rank-command.text_00a2be2684", { "name": character.name });
    const model = { title: result.title || $t("lib.ark-custom-rank-command.text_d5f4617e07"), metric: intent.metric, filters: parsed.filterText,
      count: parsed.count, rows: result.rows };
    const body = await renderRank(character, model, context).catch(() => {
      const mode = intent.metric === "damage" ? $t("lib.ark-custom-rank-command.text_30e1196888") : game === "gs" ? $t("lib.ark-custom-rank-command.text_0e1133fcd3") : $t("lib.ark-custom-rank-command.text_08ddb000a9");
      return [$t("lib.ark-custom-rank-command.text_4c967dae45", { "name": character.name, "mode": mode }), $t("lib.ark-custom-rank-command.text_83dbb3680a", { "filterText": parsed.filterText }),
        ...result.rows.map((row, i) => `${i + 1}. ${row.uid} · ${(intent.metric === "damage" ? row.damage : row.score) ?? "—"}`)].join("\n");
    });
    if (active.aborted) return;
    if (needsToken && !admittedOwner(context)) return $t("lib.ark-custom-rank-command.text_c09e0c00a9");
    return { type: "delivery", message: body, onDelivered(messageId) {
      if (active.aborted || (needsToken && !admittedOwner(context))) return;
      sessions.remember(context, messageId, { game, characterId: character.id, name: character.name, queryId: result.queryId,
        count: result.rows.length, uids: result.rows.slice(0, 20).map(({ uid }) => uid),
        ...(needsToken && { authorizedBy: context.user_id }) });
    } };
  };
}
