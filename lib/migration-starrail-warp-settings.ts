import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseDocument } from "yaml";
import { readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";

const maxBytes = 512 * 1024;
const mappable = /^[1-9]\d*$/u;
const mergedFlower = rejectionReason(["flower-plugin"], []);

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return value as Record<string, unknown>;
  }
}

function decode(bytes?: Uint8Array) {
  if (!bytes) return {};
  const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { strict: true, uniqueKeys: true });
  if (!document.errors.length && !document.warnings.length) {
    const result = record(document.toJS({ maxAliasCount: 0 }));
    if (result) return result;
  }
  throw new TypeError("旧星铁模拟设置 YAML 无效。");
}

function ticketFields(value: unknown) {
  const source = record(value);
  if (!source) return {};
  return {
    ...(source.pink === undefined ? {} : { special: source.pink }),
    ...(source.blue === undefined ? {} : { regular: source.blue }),
  };
}

export async function stageLegacyStarRailWarpSettings(archive: string | undefined, stage: string,
  plugins: readonly LegacyPluginPlanEntry[], signal?: AbortSignal) {
  if (!archive) return { active: false, deferred: false };
  const directories = plugins.filter(plugin => plugin.status === "archive" && plugin.kind === "directory" && plugin.reason === mergedFlower);
  const canonical = directories.find(plugin => plugin.path === "plugins/flower-plugin");
  for (const directory of canonical ? [canonical, ...directories.filter(entry => entry !== canonical)] : directories) {
    const legacy = join(archive, basename(directory.path), "GachaMOD/StarRail");
    const [coinDefaults, coinConfig, gachaDefaults, gachaConfig] = await Promise.all(
      ["def/coin.yaml", "config/coin.yaml", "def/gacha.yaml", "config/gacha.yaml"].map(async file =>
        (await readMigrationSourceFile(archive, join(legacy, file), maxBytes, signal))?.bytes),
    );
    if (!coinDefaults && !coinConfig && !gachaDefaults && !gachaConfig) continue;
    const { defaultWarpSettings, parseWarpSettings } = await import("../plugins/starrail/simulation/settings.ts");
    let settings;
    try {
      const coins = { ...decode(coinDefaults), ...decode(coinConfig) };
      const gacha = { ...decode(gachaDefaults), ...decode(gachaConfig) };
      const allowance = ticketFields(coins.default);
      const groups = Object.fromEntries(Object.keys(coins).filter(group => mappable.test(group)).flatMap(group => {
        const fields = ticketFields(coins[group]);
        return Object.keys(fields).length ? [[group, fields]] : [];
      }));
      if (!Object.keys(allowance).length && !Object.keys(groups).length && gacha.delMsg === undefined) continue;
      const defaults = defaultWarpSettings();
      settings = parseWarpSettings({ ...defaults, groups, allowance: {
        ...defaults.allowance, ...allowance, ...(gacha.delMsg === undefined ? {} : { recallSeconds: gacha.delMsg }),
      } });
    } catch {
      return { active: false, deferred: true };
    }
    const output = join(stage, "data/starrail/simulation/settings/1");
    await mkdir(output, { recursive: true, mode: 0o700 });
    if (!(await lstat(output)).isDirectory() || await realpath(output) !== output) throw new Error("星铁模拟设置暂存路径须为实体目录。");
    signal?.throwIfAborted();
    await writeFile(join(output, "1.json"), JSON.stringify(settings), { flag: "wx", mode: 0o600 });
    return { active: true, deferred: false };
  }
  return { active: false, deferred: false };
}
