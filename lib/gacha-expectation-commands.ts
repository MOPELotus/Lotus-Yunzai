import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { maxGachaExpectationCopies, type GachaExpectationPool, type GachaExpectationRequest,
  type GachaPullStatistics } from "@lotus-yunzai/gacha/expectation";
import { GachaReturnSimulationBusyError, type GachaCharacterPool, type GachaCharacterReturnRequest,
  type GachaCharacterReturnStatistics } from "@lotus-yunzai/gacha/character-returns";
import type { CommandModule } from "./commands.ts";

export const gachaExpectationModuleName = "@lotus-yunzai/gacha-expectation";

const commandPattern = /^#(期望计算|期望分布)([^\r\n]*)$/u;
const helpCommand = "#期望计算帮助";
const help = [
  $t("lib.gacha-expectation-commands.text_41df762a17"),
  $t("lib.gacha-expectation-commands.text_3c40ce8257"),
  $t("lib.gacha-expectation-commands.text_9f0d70ba8b"),
  $t("lib.gacha-expectation-commands.text_10220f79be"),
  $t("lib.gacha-expectation-commands.text_c310fb9b97"),
  $t("lib.gacha-expectation-commands.text_c316b0b754"),
  $t("lib.gacha-expectation-commands.text_46cbeaccda"),
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
const gameLabels = new Map([["genshin", $t("lib.gacha-expectation-commands.text_d1597c51ed")], ["hsr", $t("lib.gacha-expectation-commands.text_8cfc959b53")], ["zzz", $t("lib.gacha-expectation-commands.text_b1110352c9")]]);
const poolLabels = new Map([["character", $t("lib.gacha-expectation-commands.text_c47b54e84e")], ["weapon", $t("lib.gacha-expectation-commands.text_0b55e51f12")], ["lightcone", $t("lib.gacha-expectation-commands.text_e733238b28")]]);
const pools = {
  "genshin-character": { name: $t("lib.gacha-expectation-commands.text_f1abedce60"), unit: $t("lib.gacha-expectation-commands.text_3a116815bc"), currency: $t("lib.gacha-expectation-commands.text_761ab59423"), hardPity: 90 },
  "genshin-weapon": { name: $t("lib.gacha-expectation-commands.text_1cc399d638"), unit: $t("lib.gacha-expectation-commands.text_2442748e41"), currency: $t("lib.gacha-expectation-commands.text_761ab59423"), hardPity: 80 },
  "hsr-character": { name: $t("lib.gacha-expectation-commands.text_f1abedce60"), unit: $t("lib.gacha-expectation-commands.text_3a116815bc"), currency: $t("lib.gacha-expectation-commands.text_ae25247f75"), hardPity: 90 },
  "hsr-lightcone": { name: $t("lib.gacha-expectation-commands.text_d443fdfad8"), unit: $t("lib.gacha-expectation-commands.text_f56a049fcc"), currency: $t("lib.gacha-expectation-commands.text_ae25247f75"), hardPity: 80 },
  "zzz-character": { name: $t("lib.gacha-expectation-commands.text_405912b1b2"), unit: $t("lib.gacha-expectation-commands.text_1aa9c4170b"), currency: $t("lib.gacha-expectation-commands.text_241bb2544c"), hardPity: 90 },
  "zzz-weapon": { name: $t("lib.gacha-expectation-commands.text_2a4bc64afe"), unit: $t("lib.gacha-expectation-commands.text_3a116815bc"), currency: $t("lib.gacha-expectation-commands.text_241bb2544c"), hardPity: 80 },
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
  "genshin-character": $t("lib.gacha-expectation-commands.text_23ea992490"), "hsr-character": $t("lib.gacha-expectation-commands.text_dbcba200bb"), "zzz-character": $t("lib.gacha-expectation-commands.text_eda788307b"),
};

function isPool(value: string): value is GachaExpectationPool {
  return Object.hasOwn(pools, value);
}

function isCharacterPool(pool: GachaExpectationPool): pool is GachaCharacterPool {
  return Object.hasOwn(returnNames, pool);
}

function parse(input: string) {
  if (!input.trim()) return $t("lib.gacha-expectation-commands.text_169c45d041", { "helpCommand": helpCommand });
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
      if (!field) return $t("lib.gacha-expectation-commands.text_f42b720bff", { "helpCommand": helpCommand });
      const number = Number(field[1].exec(alias)?.[1]);
      if (!Number.isSafeInteger(number)) return $t("lib.gacha-expectation-commands.text_033c050617");
      values[field[0]] = number;
    }
  }
  if (!game || !kind) return $t("lib.gacha-expectation-commands.text_169c45d041", { "helpCommand": helpCommand });
  const pool = `${game}-${kind}`;
  const gameLabel = gameLabels.get(game);
  if (!isPool(pool)) return $t("lib.gacha-expectation-commands.text_1e7905c696", { "gameLabel": gameLabel, "value2": poolLabels.get(kind) });
  const { copies = 1, pity = 0, budget, radiance, fate } = values;
  const { hardPity } = pools[pool];
  if (copies < 1 || copies > maxGachaExpectationCopies) return $t("lib.gacha-expectation-commands.text_4f169df6c8", { "maxGachaExpectationCopies": maxGachaExpectationCopies });
  if (pity >= hardPity) return $t("lib.gacha-expectation-commands.text_3fd9b3882e", { "value1": hardPity - 1 });
  if (radiance !== undefined && pool !== "genshin-character") return $t("lib.gacha-expectation-commands.text_dcf5c0365e");
  if (radiance !== undefined && radiance > 3) return $t("lib.gacha-expectation-commands.text_64afc7c2ff");
  if (fate !== undefined && pool !== "genshin-weapon") return $t("lib.gacha-expectation-commands.text_8a9cd9aded");
  if (fate !== undefined && fate > 1) return $t("lib.gacha-expectation-commands.text_3f837c0958");
  if (fourStarMax && kind !== "character") return $t("lib.gacha-expectation-commands.text_62843fc38d");
  return { pool, gameLabel, copies, pity, guaranteed, fourStarMax, radiance, fate, budget };
}

type Parsed = Exclude<ReturnType<typeof parse>, string>;

function report(input: Parsed, result: GachaPullStatistics, distribution: boolean, returns: string | undefined): string {
  const pool = pools[input.pool];
  const guaranteed = input.guaranteed || input.fate === 1;
  const lines = [
    $t("lib.gacha-expectation-commands.text_7a4de9b8ff", { "gameLabel": input.gameLabel, "name": pool.name, "copies": input.copies, "unit": pool.unit }),
    $t("lib.gacha-expectation-commands.text_a5f29000bb", { "pity": input.pity, "value2": guaranteed ? $t("lib.gacha-expectation-commands.text_35de1616a1") : $t("lib.gacha-expectation-commands.text_a1d195e67a") }),
  ];
  if (input.pool === "genshin-character") lines.push($t("lib.gacha-expectation-commands.text_31c1ca9fb2", { "value1": input.radiance ?? 0 }));
  if (input.pool === "genshin-weapon") lines.push($t("lib.gacha-expectation-commands.text_e875488d1f", { "value1": input.fate ?? 0 }));
  lines.push("", $t("lib.gacha-expectation-commands.text_6320725393", { "value1": result.mean.toFixed(2) }));
  if (distribution) {
    lines.push($t("lib.gacha-expectation-commands.text_f3d67e1e59"), ...[
      [25, result.p25], [50, result.p50], [75, result.p75], [90, result.p90], [95, result.p95],
    ].map(([probability, pulls]) => $t("lib.gacha-expectation-commands.text_d9898da546", { "probability": probability, "pulls": pulls })));
    if (input.budget !== undefined && result.budgetChance !== undefined) {
      lines.push($t("lib.gacha-expectation-commands.text_84d48ce3b9", { "budget": input.budget, "value2": (result.budgetChance * 100).toFixed(2) }));
    }
  } else if (input.budget !== undefined) {
    lines.push($t("lib.gacha-expectation-commands.text_92606643f4"));
  }
  lines.push($t("lib.gacha-expectation-commands.text_87bcaa8f9b", { "value1": Math.ceil(result.mean), "value2": (Math.ceil(result.mean) * 160).toLocaleString("zh-CN"), "currency": pool.currency }));
  if (returns !== undefined) lines.push("", returns);
  lines.push("", $t("lib.gacha-expectation-commands.text_3389170795"));
  return lines.join("\n");
}

function returnReport(pool: GachaCharacterPool, fourStarMax: boolean, result: GachaCharacterReturnStatistics): string {
  return [
    $t("lib.gacha-expectation-commands.text_a51f52340a", { "value1": returnNames[pool], "value2": fourStarMax ? $t("lib.gacha-expectation-commands.text_3f5a51a4b4") : $t("lib.gacha-expectation-commands.text_0e4a2e0679") }),
    $t("lib.gacha-expectation-commands.text_fa172bf96e", { "value1": result.mean.toFixed(2) }),
    $t("lib.gacha-expectation-commands.text_fa096062df", { "p25": result.p25, "p50": result.p50, "p75": result.p75 }),
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
      await context.reply(distribution ? $t("lib.gacha-expectation-commands.text_c1b7fba1eb") : $t("lib.gacha-expectation-commands.text_5fe555915e"));
      try {
        if (signal?.aborted) return;
        const result = await compute({ pool, copies, pity, guaranteed, radiance, fate, budget: distribution ? budget : undefined });
        if (signal?.aborted) return;
        let returns: string | undefined;
        if (distribution && isCharacterPool(pool)) {
          if (!sample) {
            returns = $t("lib.gacha-expectation-commands.text_eef85cc99f");
          } else {
            const up4C6 = input.fourStarMax;
            try {
              returns = returnReport(pool, up4C6, await sample({
                pool, copies, pity, guaranteed, radiance, up4C6,
              }, { signal }));
            } catch (error) {
              returns = error instanceof GachaReturnSimulationBusyError ? $t("lib.gacha-expectation-commands.text_4ff43e45a0")
                : $t("lib.gacha-expectation-commands.text_8b8790e5fe");
            }
          }
        }
        if (signal?.aborted) return;
        return { type: "quoted", message: report(input, result, distribution, returns) };
      } catch {
        if (signal?.aborted) return;
        return { type: "quoted", message: $t("lib.gacha-expectation-commands.text_e85201933a") };
      }
    },
  };
}
