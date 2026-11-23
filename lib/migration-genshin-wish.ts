import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseDocument } from "yaml";
import { inheritWishSettings, legacyWishReincarnationMinutes } from "./genshin-wish-settings-model.ts";
import { wishConfigMaxBytes, wishConfigName } from "./genshin-wish-settings.ts";
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

export async function stageLegacyGenshinWishConfig(source: string, archive: string | undefined, stage: string,
  plugins: readonly LegacyPluginPlanEntry[], signal?: AbortSignal) {
  const reason = rejectionReason(["flower-plugin"], []);
  const entries = plugins.filter(plugin => plugin.status === "archive" && plugin.kind === "directory" && plugin.reason === reason);
  const flower = entries.find(plugin => plugin.path === "plugins/flower-plugin") ?? entries[0];
  async function read(root: string, relative: string) {
    return (await readMigrationSourceFile(root, join(root, relative), wishConfigMaxBytes, signal))?.bytes;
  }
  const [stock, tickets, fallbackRecall, stockRules, customRules] = await Promise.all([
    archive && flower ? read(archive, join(basename(flower.path), "GachaMOD/Genshin/def/coin.yaml")) : undefined,
    archive && flower ? read(archive, join(basename(flower.path), "GachaMOD/Genshin/config/coin.yaml")) : undefined,
    read(source, "plugins/genshin/config/gacha.set.yaml"),
    archive && flower ? read(archive, join(basename(flower.path), "GachaMOD/Genshin/def/gacha.yaml")) : undefined,
    archive && flower ? read(archive, join(basename(flower.path), "GachaMOD/Genshin/config/gacha.yaml")) : undefined,
  ]);
  if (!tickets && !stock && !fallbackRecall && !customRules && !stockRules) return { active: false, deferred: false };
  let settings;
  try {
    const coins = { ...(stock ? decode(stock) : {}), ...(tickets ? decode(tickets) : {}) };
    const customization = customRules && decode(customRules);
    const defaults = stockRules && decode(stockRules);
    const privateSingle = customization?.delMsg ?? defaults?.delMsg;
    const cooldown = legacyWishReincarnationMinutes(customization?.relifeCD, defaults?.relifeCD);
    if (!tickets && !stock && !fallbackRecall && privateSingle === undefined && cooldown === undefined) {
      return { active: false, deferred: false };
    }
    settings = inheritWishSettings(coins, fallbackRecall && decode(fallbackRecall), privateSingle, cooldown);
  } catch {
    return { active: false, deferred: true };
  }
  const destination = join(stage, "config");
  await mkdir(destination, { mode: 0o700, recursive: true });
  if (!(await lstat(destination)).isDirectory() || await realpath(destination) !== destination) throw new Error("模拟祈愿配置暂存路径须为实体目录。");
  signal?.throwIfAborted();
  await writeFile(join(destination, `${wishConfigName}.yaml`), Bun.YAML.stringify(settings), { flag: "wx", mode: 0o600 });
  return { active: true, deferred: false };
}
