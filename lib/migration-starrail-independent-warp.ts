import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseDocument } from "yaml";
import { readMigrationSourceFile, MigrationSourceFileError } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";

const maxBytes = 512 * 1024;
const independent = rejectionReason(["starrail-plugin"], []);

export async function stageLegacyStarRailIndependentWarp(archive: string | undefined, stage: string,
  plugins: readonly LegacyPluginPlanEntry[], signal?: AbortSignal) {
  if (!archive) return { active: false, deferred: false };
  const sources = plugins.filter(plugin => plugin.status === "archive" && plugin.kind === "directory" && plugin.reason === independent);
  sources.sort((a, b) => Number(b.path.toLowerCase() === "plugins/starrail-plugin") - Number(a.path.toLowerCase() === "plugins/starrail-plugin"));
  for (const plugin of sources) {
    let settings;
    try {
      const base = join(archive, basename(plugin.path));
      const [defaults, overrides] = await Promise.all(["defSet", "config"].map(async subfolder => {
        const file = await readMigrationSourceFile(archive, join(base, subfolder, "gccfg.yaml"), maxBytes, signal);
        if (!file) return;
        const yaml = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes), { strict: true, uniqueKeys: true });
        if (yaml.errors.length || yaml.warnings.length) throw new TypeError($t("lib.migration-starrail-independent-warp.text_4c521aaf5d"));
        return yaml.toJS({ maxAliasCount: 0 }) as unknown;
      }));
      if (defaults === undefined && overrides === undefined) continue;
      const { convertIndependentWarpSettings } = await import("../plugins/starrail/simulation/independent-settings.ts");
      settings = convertIndependentWarpSettings(defaults, overrides);
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof TypeError) && !(error instanceof MigrationSourceFileError)) throw error;
      return { active: false, deferred: true };
    }
    const output = join(stage, "data/starrail/simulation/independent-settings/1");
    await mkdir(output, { recursive: true, mode: 0o700 });
    if (!(await lstat(output)).isDirectory() || await realpath(output) !== output) throw new Error($t("lib.migration-starrail-independent-warp.text_d9028b930f"));
    signal?.throwIfAborted();
    await writeFile(join(output, "1.json"), JSON.stringify(settings), { flag: "wx", mode: 0o600 });
    return { active: true, deferred: false };
  }
  return { active: false, deferred: false };
}
