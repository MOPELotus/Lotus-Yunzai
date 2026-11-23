import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArtifactListLimit, parsePanelCommaGroup } from "./group-panel-rank-settings.ts";
import { readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";

const mergedRankPlugin = rejectionReason(["miao-plugin"], []);
const rankConfig = "config/panel-rank.yaml";
const maxBytes = 256 * 1024;
const rankKeys = ["groupRank", "rankNumber", "groupRankLimit"];

// The legacy settings writer emits literal exports. Treat the archived JS as data.
function legacySettings(text: string) {
  const source = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/gu,
    token => token.startsWith("/") ? token.replace(/[^\r\n]/gu, " ") : token.replace(/[^\r\n]/gu, "?"));
  const fields = new Map<string, string>();
  for (const [, key, value] of source.matchAll(/^[ \t]*export[ \t]+const[ \t]+(groupRank|rankNumber|groupRankLimit|artisNumber|commaGroup)[ \t]*=([^\r\n]*)$/gmu)) {
    if (key !== undefined && value !== undefined) fields.set(key, fields.has(key) ? "" : value.trim().replace(/;$/u, "").trim());
  }
  if (!fields.size) return;
  const config: Record<string, boolean | number> = {};
  let deferred = false;
  if (rankKeys.some(key => fields.has(key))) {
    const enabled = fields.get("groupRank") ?? "false";
    const size = fields.get("rankNumber") ?? "15";
    const count = Number(size);
    if ((enabled === "true" || enabled === "false") && /^\d+$/u.test(size) && count >= 5 && count <= 30) {
      Object.assign(config, {
        gsDefault: enabled === "true", srDefault: enabled === "true", gsLimit: count, srLimit: count,
        legacyGroupStatus: true,
      });
      const policy = fields.get("groupRankLimit");
      if (/^[1-5]$/u.test(policy ?? "")) config.legacyGroupRankLimit = Number(policy);
    } else {
      deferred = true;
    }
  }
  const artifactSize = fields.get("artisNumber");
  if (artifactSize !== undefined) {
    const limit = /^\d+$/u.test(artifactSize) ? parseArtifactListLimit(Number(artifactSize)) : undefined;
    if (limit === undefined) deferred = true;
    else config.artifactListLimit = limit;
  }
  const commaSize = fields.get("commaGroup");
  if (commaSize !== undefined) {
    const grouping = /^\d+$/u.test(commaSize) ? parsePanelCommaGroup(Number(commaSize)) : undefined;
    if (grouping === undefined) deferred = true;
    else config.commaGroup = grouping;
  }
  return { config, deferred };
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
    if (!Object.keys(settings.config).length) return { active: false, deferred: settings.deferred };
    const destination = join(stage, "config");
    await mkdir(destination, { mode: 0o700, recursive: true });
    if (!(await lstat(destination)).isDirectory() || await realpath(destination) !== destination) {
      throw new Error("群榜配置暂存路径须为实体目录。");
    }
    signal?.throwIfAborted();
    await writeFile(join(stage, rankConfig), Bun.YAML.stringify(settings.config), { flag: "wx", mode: 0o600 });
    return { active: true, deferred: settings.deferred };
  }
  return { active: false, deferred: false };
}
