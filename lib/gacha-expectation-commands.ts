import { maxGachaExpectationCopies, type GachaExpectationPool, type GachaExpectationRequest,
  type GachaPullStatistics } from "@lotus-yunzai/gacha/expectation";
import { GachaReturnSimulationBusyError, type GachaCharacterPool, type GachaCharacterReturnRequest,
  type GachaCharacterReturnStatistics } from "@lotus-yunzai/gacha/character-returns";
import type { CommandModule } from "./commands.ts";

export const gachaExpectationModuleName = "@lotus-yunzai/gacha-expectation";

const commandPattern = /^#(期望计算|期望分布)([^\r\n]*)$/u;
const helpCommand = "#期望计算帮助";
const help = [
  "#期望计算 查看平均抽数。#期望分布 查看抽数分位和预算达成率。",
  "结果按旧卡池模型估算。",
  "用空格分隔参数。游戏和卡池必填：原神（角色、武器），星铁（角色、光锥），绝区零（角色、音擎）。",
  "可加 2个、30垫、大保底。默认抽 1 个，垫 0 抽，小保底。",
  "原神角色可加 明光2（0–3），原神武器可加 定轨1（0–1）。",
  "角色池查分布时，可加 四星满命 估算返还。",
  "示例：#期望分布 绝区零 音擎 2个 30垫 预算160抽",
].join("\n");

const gameAliases = new Map([
  ["原神", "genshin"], ["genshin", "genshin"], ["星铁", "hsr"], ["崩铁", "hsr"], ["hsr", "hsr"],
  ["绝区零", "zzz"], ["zzz", "zzz"],
]);
const poolAliases = new Map([
  ["角色", "character"], ["人物", "character"], ["武器", "weapon"], ["音擎", "weapon"], ["光锥", "lightcone"],
]);
const guaranteeAliases = new Map([["大保底", true], ["必出", true], ["小保底", false], ["不歪", false]]);
const starsAliases = new Set(["四星满命", "up4满命", "up4c6"]);
const gameLabels = new Map([["genshin", "原神"], ["hsr", "崩坏：星穹铁道"], ["zzz", "绝区零"]]);
const poolLabels = new Map([["character", "角色"], ["weapon", "武器或音擎"], ["lightcone", "光锥"]]);
const pools = {
  "genshin-character": { name: "限定角色", unit: "个", currency: "原石", hardPity: 90 },
  "genshin-weapon": { name: "定轨武器", unit: "把", currency: "原石", hardPity: 80 },
  "hsr-character": { name: "限定角色", unit: "个", currency: "星琼", hardPity: 90 },
  "hsr-lightcone": { name: "限定光锥", unit: "张", currency: "星琼", hardPity: 80 },
  "zzz-character": { name: "限定代理人", unit: "位", currency: "菲林", hardPity: 90 },
  "zzz-weapon": { name: "限定音擎", unit: "个", currency: "菲林", hardPity: 80 },
} satisfies Record<GachaExpectationPool, { name: string; unit: string; currency: string; hardPity: number }>;

const numericFields = [
  ["copies", /^(\d+)(?:个|把|张|命|魂|精|特写)$/u], ["pity", /^(\d+)(?:抽|垫)$/u],
  ["budget", /^(?:预算|持有|目标)(\d+)(?:抽|发)?$/u], ["radiance", /^(?:明光|明光计数)(\d+)$/u],
  ["fate", /^(?:命定|定轨)值?(\d+)$/u],
] as const;

type Compute = (request: GachaExpectationRequest) => GachaPullStatistics | Promise<GachaPullStatistics>;
type Sample = (request: GachaCharacterReturnRequest, options?: { signal?: AbortSignal }) =>
  GachaCharacterReturnStatistics | Promise<GachaCharacterReturnStatistics>;

const returnNames: Record<GachaCharacterPool, string> = {
  "genshin-character": "星辉", "hsr-character": "星芒", "zzz-character": "信号余波",
};

function isPool(value: string): value is GachaExpectationPool {
  return Object.hasOwn(pools, value);
}

function isCharacterPool(pool: GachaExpectationPool): pool is GachaCharacterPool {
  return Object.hasOwn(returnNames, pool);
}

function parse(input: string) {
  if (!input.trim()) return `请填写游戏和卡池。发送 ${helpCommand} 查看用法。`;
  const values: Partial<Record<(typeof numericFields)[number][0], number>> = {};
  let game: string | undefined;
  let kind: string | undefined;
  let guaranteed = false;
  let fourStarMax = false;
  for (const token of input.trim().split(/\s+/u)) {
    const alias = token.toLowerCase();
    const gameAlias = gameAliases.get(alias);
    const poolAlias = poolAliases.get(alias);
    const guarantee = guaranteeAliases.get(alias);
    if (gameAlias !== undefined) game = gameAlias;
    else if (poolAlias !== undefined) kind = poolAlias;
    else if (guarantee !== undefined) guaranteed = guarantee;
    else if (starsAliases.has(alias)) fourStarMax = true;
    else {
      const index = numericFields.findIndex(([, pattern]) => pattern.test(alias));
      const field = numericFields[index];
      if (!field) return `有一个参数无法识别。发送 ${helpCommand} 查看用法。`;
      const number = Number(field[1].exec(alias)?.[1]);
      if (!Number.isSafeInteger(number)) return "数值过大，请检查数量、垫抽和预算。";
      values[field[0]] = number;
    }
  }
  if (!game || !kind) return `请填写游戏和卡池。发送 ${helpCommand} 查看用法。`;
  const pool = `${game}-${kind}`;
  const gameLabel = gameLabels.get(game);
  if (!isPool(pool)) return `${gameLabel}没有可计算的${poolLabels.get(kind)}卡池。`;
  const { copies = 1, pity = 0, budget, radiance, fate } = values;
  const { hardPity } = pools[pool];
  if (copies < 1 || copies > maxGachaExpectationCopies) return `目标数量须在 1 到 ${maxGachaExpectationCopies} 之间。`;
  if (pity >= hardPity) return `该卡池的垫抽须在 0 到 ${hardPity - 1} 之间。`;
  if (radiance !== undefined && pool !== "genshin-character") return "明光计数仅适用于原神角色池。";
  if (radiance !== undefined && radiance > 3) return "明光计数须在 0 到 3 之间。";
  if (fate !== undefined && pool !== "genshin-weapon") return "定轨值仅适用于原神武器池。";
  if (fate !== undefined && fate > 1) return "定轨值须在 0 到 1 之间。";
  if (fourStarMax && kind !== "character") return "四星满命仅适用于角色池。";
  return { pool, gameLabel, copies, pity, guaranteed, fourStarMax, radiance, fate, budget };
}

type Parsed = Exclude<ReturnType<typeof parse>, string>;

function report(input: Parsed, result: GachaPullStatistics, distribution: boolean, returns: string | undefined): string {
  const pool = pools[input.pool];
  const guaranteed = input.guaranteed || input.fate === 1;
  const lines = [
    `${input.gameLabel} ${pool.name} · 目标 ${input.copies} ${pool.unit}`,
    `已垫 ${input.pity} 抽 · ${guaranteed ? "大保底" : "小保底"}`,
  ];
  if (input.pool === "genshin-character") lines.push(`明光计数 ${input.radiance ?? 0}`);
  if (input.pool === "genshin-weapon") lines.push(`定轨值 ${input.fate ?? 0}`);
  lines.push("", `期望抽数 ${result.mean.toFixed(2)} 抽`);
  if (distribution) {
    lines.push("在以下抽数内达成目标的概率", ...[
      [25, result.p25], [50, result.p50], [75, result.p75], [90, result.p90], [95, result.p95],
    ].map(([probability, pulls]) => `${probability}% · ${pulls} 抽`));
    if (input.budget !== undefined && result.budgetChance !== undefined) {
      lines.push(`预算 ${input.budget} 抽 · 达成率 ${(result.budgetChance * 100).toFixed(2)}%`);
    }
  } else if (input.budget !== undefined) {
    lines.push("用 #期望分布 查看预算达成率。");
  }
  lines.push(`按 ${Math.ceil(result.mean)} 抽折算约 ${(Math.ceil(result.mean) * 160).toLocaleString("zh-CN")} ${pool.currency}`);
  if (returns !== undefined) lines.push("", returns);
  lines.push("", "按旧卡池模型估算");
  return lines.join("\n");
}

function returnReport(pool: GachaCharacterPool, fourStarMax: boolean, result: GachaCharacterReturnStatistics): string {
  return [
    `预计返还${returnNames[pool]}（模拟） · UP 四星${fourStarMax ? "已满命" : "未满命"}`,
    `平均 ${result.mean.toFixed(2)} 个`,
    `25% 分位 ${result.p25} 个 · 50% 分位 ${result.p50} 个 · 75% 分位 ${result.p75} 个`,
  ].join("\n");
}

export function isGachaExpectationInput(message: string): boolean {
  return commandPattern.test(message.trim());
}

export function gachaExpectationCommands(compute: Compute, sample?: Sample): CommandModule {
  return {
    name: gachaExpectationModuleName,
    commands: {},
    async fallback(_message, context) {
      const message = context.normalizedMessage.trim();
      const { calculationSignal: signal } = context;
      if (signal?.aborted) return;
      if (message === helpCommand) return help;
      const match = commandPattern.exec(message);
      if (!match) return;
      const input = parse(match[2] ?? "");
      if (typeof input === "string") return input;
      const { pool, copies, pity, guaranteed, radiance, fate, budget } = input;
      const distribution = match[1] === "期望分布";
      await context.reply(distribution ? "正在计算抽数分布…" : "正在计算平均抽数…");
      try {
        if (signal?.aborted) return;
        const result = await compute({ pool, copies, pity, guaranteed, radiance, fate, budget: distribution ? budget : undefined });
        if (signal?.aborted) return;
        let returns: string | undefined;
        if (distribution && isCharacterPool(pool)) {
          if (!sample) {
            returns = "当前结果仅展示抽数，四星满命状态和兑换道具返还尚未纳入计算。";
          } else {
            const up4C6 = input.fourStarMax;
            try {
              returns = returnReport(pool, up4C6, await sample({
                pool, copies, pity, guaranteed, radiance, up4C6,
              }, { signal }));
            } catch (error) {
              returns = error instanceof GachaReturnSimulationBusyError ? "返还估算正在处理另一条请求，请稍后重试。"
                : "暂时无法估算返还，请稍后重试。";
            }
          }
        }
        if (signal?.aborted) return;
        return { type: "quoted", message: report(input, result, distribution, returns) };
      } catch {
        if (signal?.aborted) return;
        return { type: "quoted", message: "抽卡计算暂未完成，请稍后重试。" };
      }
    },
  };
}
