import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseDocument } from "yaml";
import { inheritWishSettings, legacyWishPools, legacyWishReincarnationMinutes, legacyWishRules, parseWishSettings, type WishSettings } from "./genshin-wish-settings-model.ts";
import { wishConfigMaxBytes, wishConfigName } from "./genshin-wish-settings.ts";
import { migrateWishDailyDrawLimits } from "./migration-genshin-wish-limits.ts";
import { readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";

function decode(bytes: Uint8Array): Record<string, unknown> {
  const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { strict: true, uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new TypeError($t("lib.migration-genshin-wish.text_0697509106"));
  const result: unknown = document.toJS({ maxAliasCount: 0 });
  if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
  throw new TypeError($t("lib.migration-genshin-wish.text_8b31b6b28c"));
}

function decodeOptionalPool(bytes: Uint8Array | undefined) {
  if (bytes) {
    try { return decode(bytes); } catch { return; }
  }
}

const wishConfigPath = `config/${wishConfigName}.yaml`;

function archivedFlower(plugins: readonly LegacyPluginPlanEntry[]) {
  const reason = rejectionReason(["flower-plugin"], []);
  const entries = plugins.filter(plugin => plugin.status === "archive" && plugin.kind === "directory" && plugin.reason === reason);
  return entries.find(plugin => plugin.path === "plugins/flower-plugin") ?? entries[0];
}

async function read(source: string, relative: string, signal?: AbortSignal) {
  return (await readMigrationSourceFile(source, join(source, relative), wishConfigMaxBytes, signal))?.bytes;
}

async function projectWishConfig(source: string, flower: { root: string; path: string } | undefined,
  modern: Uint8Array | undefined, signal?: AbortSignal): Promise<
    { active: true; deferred: false; yaml: string | Uint8Array; settings: WishSettings } |
    { active: false; deferred: boolean }> {
  modern ??= await read(source, wishConfigPath, signal);
  if (modern) {
    try { return { active: true, deferred: false, yaml: modern, settings: parseWishSettings(decode(modern)) }; }
    catch { return { active: false, deferred: true }; }
  }

  const oldFlower = (file: string) => flower ? read(flower.root, join(flower.path, file), signal) : undefined;
  const [stock, tickets, fallbackRecall, stockRules, customRules, customPool] = await Promise.all([
    oldFlower("def/coin.yaml"), oldFlower("config/coin.yaml"), read(source, "plugins/genshin/config/gacha.set.yaml", signal),
    oldFlower("def/gacha.yaml"), oldFlower("config/gacha.yaml"), oldFlower("config/pool.yaml"),
  ]);
  if (!tickets && !stock && !fallbackRecall && !customRules && !stockRules && !customPool) {
    return { active: false, deferred: false };
  }
  try {
    const stockCoins = stock && decode(stock);
    const customCoins = tickets && decode(tickets);
    const coins = { ...stockCoins, ...customCoins };
    const oldLimits = fallbackRecall && decode(fallbackRecall);
    const customization = customRules && decode(customRules);
    const defaults = stockRules && decode(stockRules);
    const privateSingle = customization?.delMsg ?? defaults?.delMsg;
    const cooldown = legacyWishReincarnationMinutes(customization?.relifeCD, defaults?.relifeCD);
    const rules = { ...legacyWishRules(customization, defaults), ...legacyWishPools(decodeOptionalPool(customPool), customization, defaults) };
    if (!tickets && !stock && !fallbackRecall && privateSingle === undefined && cooldown === undefined && !Object.keys(rules).length) {
      return { active: false, deferred: false };
    }
    const inherited = inheritWishSettings(coins, oldLimits, privateSingle, cooldown, rules);
    const settings = { ...inherited, dailyDrawLimits: migrateWishDailyDrawLimits(oldLimits, customCoins, stockCoins) };
    return { active: true, deferred: false, yaml: Bun.YAML.stringify(settings), settings };
  } catch {
    return { active: false, deferred: true };
  }
}

export async function planGenshinWishSettings(source: string, plugins: readonly LegacyPluginPlanEntry[], signal?: AbortSignal) {
  const flower = archivedFlower(plugins);
  const config = await projectWishConfig(source,
    flower && { root: source, path: join(flower.path, "GachaMOD/Genshin") }, undefined, signal);
  return config.active ? config.settings : parseWishSettings({});
}

export async function stageLegacyGenshinWishConfig(source: string, archive: string | undefined, stage: string,
  plugins: readonly LegacyPluginPlanEntry[], signal?: AbortSignal) {
  const flower = archivedFlower(plugins);
  const copy = await read(stage, wishConfigPath, signal);
  const config = await projectWishConfig(source,
    archive && flower ? { root: archive, path: join(basename(flower.path), "GachaMOD/Genshin") } : undefined, copy, signal);
  if (config.active && !copy) {
    const destination = join(stage, "config");
    await mkdir(destination, { mode: 0o700, recursive: true });
    if (!(await lstat(destination)).isDirectory() || await realpath(destination) !== destination) throw new Error($t("lib.migration-genshin-wish.text_93dc4d4137"));
    signal?.throwIfAborted();
    await writeFile(join(stage, wishConfigPath), config.yaml, { flag: "wx", mode: 0o600 });
  }
  return { active: config.active, deferred: config.deferred };
}
