import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";
import { parseZzzRecallSeconds } from "./zzz-recall-config.ts";

const mergedZzz = rejectionReason(["zzz-plugin"], []);
const archiveLimit = 256 * 1024;
type Config = Record<string, unknown>;

async function readArchivedConfig(archive: string, path: string, signal?: AbortSignal): Promise<Config | undefined | null> {
  const file = await readMigrationSourceFile(archive, path, archiveLimit, signal);
  if (!file) return;
  try {
    const data: unknown = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    if (data === null || data === undefined) return {};
    return typeof data === "object" && !Array.isArray(data) ? data as Config : null;
  } catch { return null; }
}

export async function stageLegacyZzzRecallConfig(archive: string | undefined, stage: string,
  plugins: readonly LegacyPluginPlanEntry[], signal?: AbortSignal) {
  if (!archive) return { active: false, deferred: false };
  const candidates = plugins.filter(plugin => plugin.status === "archive" && plugin.kind === "directory" && plugin.reason === mergedZzz);
  candidates.sort((left, right) => Number(right.path === "plugins/ZZZ-Plugin") - Number(left.path === "plugins/ZZZ-Plugin"));
  for (const plugin of candidates) {
    const base = join(archive, basename(plugin.path));
    const [defaults, config] = await Promise.all([
      readArchivedConfig(archive, join(base, "defSet/config.yaml"), signal),
      readArchivedConfig(archive, join(base, "config/config.yaml"), signal),
    ]);
    if (defaults === null || config === null) return { active: false, deferred: true };
    const legacy = { ...defaults, ...config };
    if (!Object.hasOwn(legacy, "recallMsg")) continue;
    const recallMsg = parseZzzRecallSeconds(legacy.recallMsg);
    if (recallMsg === undefined) return { active: false, deferred: true };

    // Publishing the new file shadows the old panel defaults and local settings.
    const [panelDefaults, panelConfig] = await Promise.all([
      readArchivedConfig(archive, join(base, "defSet/panel.yaml"), signal),
      readArchivedConfig(archive, join(base, "config/panel.yaml"), signal),
    ]);
    if (panelDefaults === null || panelConfig === null) return { active: false, deferred: true };
    const directory = join(stage, "config");
    await mkdir(directory, { mode: 0o700, recursive: true });
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) {
      throw new Error("绝区零面板配置暂存路径须为实体目录。");
    }
    signal?.throwIfAborted();
    await writeFile(join(directory, "zzz-panel.yaml"), Bun.YAML.stringify({ ...panelDefaults, ...panelConfig, recallMsg }),
      { flag: "wx", mode: 0o600 });
    return { active: true, deferred: false };
  }
  return { active: false, deferred: false };
}
