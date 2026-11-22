import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";

const mergedRankPlugin = rejectionReason(["miao-plugin"], []);
const rankConfig = "config/panel-rank.yaml";
const maxBytes = 256 * 1024;

// The legacy settings writer emits literal exports. Treat the archived JS as data.
function legacySettings(text: string) {
  const source = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/gu,
    token => token.startsWith("/") ? token.replace(/[^\r\n]/gu, " ") : token.replace(/[^\r\n]/gu, "?"));
  const fields = new Map<string, string>();
  for (const [, key, value] of source.matchAll(/^[ \t]*export[ \t]+const[ \t]+(groupRank|rankNumber|groupRankLimit)[ \t]*=([^\r\n]*)$/gmu)) {
    if (key !== undefined && value !== undefined) fields.set(key, fields.has(key) ? "" : value.trim().replace(/;$/u, "").trim());
  }
  if (!fields.size) return;
  const enabled = fields.get("groupRank") ?? "false";
  const size = fields.get("rankNumber") ?? "15";
  if ((enabled !== "true" && enabled !== "false") || !/^\d+$/u.test(size)) return { deferred: true } as const;
  const count = Number(size);
  if (!Number.isSafeInteger(count) || count < 5 || count > 30) return { deferred: true } as const;
  const legacyGroupRankLimit = fields.get("groupRankLimit");
  return { config: {
    gsDefault: enabled === "true", srDefault: enabled === "true", gsLimit: count, srLimit: count,
    legacyGroupStatus: true,
    ...(/^[1-5]$/u.test(legacyGroupRankLimit ?? "") ? { legacyGroupRankLimit: Number(legacyGroupRankLimit) } : {}),
  } } as const;
}

export async function stageLegacyPanelRankConfig(archive: string | undefined, stage: string, plugins: readonly LegacyPluginPlanEntry[], signal?: AbortSignal) {
  if (!archive) return { active: false, deferred: false };
  const directories = plugins.flatMap(plugin => plugin.status === "archive" && plugin.kind === "directory" &&
    plugin.reason === mergedRankPlugin ? [plugin.path] : []);
  const canonical = "plugins/miao-plugin";
  const preferred = directories.includes(canonical) ? [canonical, ...directories.filter(path => path !== canonical)] : directories;
  for (const directory of preferred) {
    const file = await readMigrationSourceFile(archive, join(archive, basename(directory), "config/cfg.js"), maxBytes, signal);
    if (!file) continue;
    const settings = legacySettings(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    if (!settings) continue;
    if ("deferred" in settings) return { active: false, deferred: true };
    const destination = join(stage, "config");
    await mkdir(destination, { mode: 0o700, recursive: true });
    if (!(await lstat(destination)).isDirectory() || await realpath(destination) !== destination) {
      throw new Error("群榜配置暂存路径须为实体目录。");
    }
    signal?.throwIfAborted();
    await writeFile(join(stage, rankConfig), Bun.YAML.stringify(settings.config), { flag: "wx", mode: 0o600 });
    return { active: true, deferred: false };
  }
  return { active: false, deferred: false };
}
