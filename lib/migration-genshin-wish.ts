import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseDocument } from "yaml";
import { inheritWishSettings, legacyWishPools, legacyWishReincarnationMinutes, legacyWishRules, parseWishSettings } from "./genshin-wish-settings-model.ts";
import { wishConfigMaxBytes, wishConfigName } from "./genshin-wish-settings.ts";
import { migrateWishDailyDrawLimits } from "./migration-genshin-wish-limits.ts";
import { readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";

function decode(bytes: Uint8Array): Record<string, unknown> {
  const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { strict: true, uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new TypeError("旧祈愿设置 YAML 无效。");
  const result: unknown = document.toJS({ maxAliasCount: 0 });
  if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
  throw new TypeError("旧祈愿设置需为 YAML 映射。");
}

function decodeOptionalPool(bytes: Uint8Array | undefined) {
  if (bytes) {
    try { return decode(bytes); } catch { return; }
  }
}

export async function stageLegacyGenshinWishConfig(source: string, archive: string | undefined, stage: string,
  plugins: readonly LegacyPluginPlanEntry[], signal?: AbortSignal) {
  const reason = rejectionReason(["flower-plugin"], []);
  const entries = plugins.filter(plugin => plugin.status === "archive" && plugin.kind === "directory" && plugin.reason === reason);
  const flower = entries.find(plugin => plugin.path === "plugins/flower-plugin") ?? entries[0];
  async function read(root: string, relative: string) {
    return (await readMigrationSourceFile(root, join(root, relative), wishConfigMaxBytes, signal))?.bytes;
  }
  const relative = `config/${wishConfigName}.yaml`;
  const copy = await read(stage, relative);
  const modern = copy ?? await read(source, relative);
  let yaml: string | Uint8Array;
  if (modern) {
    try { parseWishSettings(decode(modern)); }
    catch { return { active: false, deferred: true }; }
    if (copy) return { active: true, deferred: false };
    yaml = modern;
  } else {
    const archived = archive && flower ? { root: archive, path: join(basename(flower.path), "GachaMOD/Genshin") } : undefined;
    const oldFlower = (file: string) => archived ? read(archived.root, join(archived.path, file)) : undefined;
    const [stock, tickets, fallbackRecall, stockRules, customRules, customPool] = await Promise.all([
      oldFlower("def/coin.yaml"), oldFlower("config/coin.yaml"), read(source, "plugins/genshin/config/gacha.set.yaml"),
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
      const settings = inheritWishSettings(coins, oldLimits, privateSingle, cooldown, rules);
      yaml = Bun.YAML.stringify({ ...settings, dailyDrawLimits: migrateWishDailyDrawLimits(oldLimits, customCoins, stockCoins) });
    } catch {
      return { active: false, deferred: true };
    }
  }
  const destination = join(stage, "config");
  await mkdir(destination, { mode: 0o700, recursive: true });
  if (!(await lstat(destination)).isDirectory() || await realpath(destination) !== destination) throw new Error("模拟祈愿配置暂存路径须为实体目录。");
  signal?.throwIfAborted();
  await writeFile(join(stage, relative), yaml, { flag: "wx", mode: 0o600 });
  return { active: true, deferred: false };
}
