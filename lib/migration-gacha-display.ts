import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseGachaDisplaySettings } from "@lotus-yunzai/gacha/display-settings";
import { parseDocument } from "yaml";
import { gachaDisplayConfigBytes, gachaDisplayConfigName } from "./gacha-display-settings.ts";
import { readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";

const miaoReason = rejectionReason(["miao-plugin"], []);
const sections = {
  luckCfg: { enable: "enabled", minSample: "minSample", levels: "levels", model: "models" },
  detailCfg: { maxLog: "detailRows" },
  statCfg: { maxVersion: "versionRows" },
} as const;

// A copied default file contains JS flow literals and comments. Preserve strings,
// strip comments, and parse only literal values. The archived script is never run.
function stripComments(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/gu,
    token => token.startsWith("/") ? token.replace(/[^\r\n]/gu, " ") : token);
}

function collectExports(text: string) {
  const exports = new Map<string, string>();
  const src = stripComments(text);
  const declarations = [...src.matchAll(/^[ \t]*export[ \t]+(?:const|let|var)[ \t]+([a-zA-Z_$][\w$]*)\s*=\s*/gmu)];
  for (const [index, match] of declarations.entries()) {
    const name = match[1]!;
    exports.set(name, exports.has(name) ? "" : src.slice(match.index + match[0].length, declarations[index + 1]?.index)
      .trim().replace(/;$/u, "").trimEnd());
  }
  return exports;
}

function readLiteral(source: string) {
  if (!source.startsWith("{") || !source.endsWith("}")) return;
  // YAML flow notation also recognizes anchors, tags and plain expressions.
  // Reject anything outside the flow literals used in the legacy template.
  const tokens = source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[{}\[\]:,]|-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_$][\w$]*|\S/gu);
  for (const { 0: token, index } of tokens) {
    if (/^["'{}\[\]:,\d.-]/u.test(token) && token !== "." && token !== "-") continue;
    if (token === "false" || token === "true" || token === "null") continue;
    if (!/^[A-Za-z_$][\w$]*$/u.test(token) || !/^\s*:/u.test(source.slice(index + token.length))) return;
  }
  try {
    const document = parseDocument(source, { strict: true, uniqueKeys: true });
    if (document.errors.length || document.warnings.length) return;
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return value as Record<string, unknown>;
    }
  } catch {
    return;
  }
}

export function legacyGachaDisplayConfig(text: string) {
  const exports = collectExports(text);
  const config: Record<string, unknown> = {};
  let deferred = false;
  for (const [section, fields] of Object.entries(sections)) {
    if (!exports.has(section)) continue;
    const values = readLiteral(exports.get(section)!);
    if (!values) {
      deferred = true;
      continue;
    }
    for (const [legacy, key] of Object.entries(fields)) {
      if (!Object.hasOwn(values, legacy)) continue;
      const entry = { [key]: values[legacy] };
      try {
        parseGachaDisplaySettings(entry);
        Object.assign(config, entry);
      } catch {
        deferred = true;
      }
    }
  }
  if (exports.has("isSys")) return { config: {}, deferred: true };
  if (!exports.size && /\b(?:luckCfg|detailCfg|statCfg)\b/u.test(stripComments(text))) deferred = true;
  return { config, deferred };
}

export async function stageLegacyGachaDisplayConfig(archive: string | undefined, stage: string,
  plugins: readonly LegacyPluginPlanEntry[], signal?: AbortSignal) {
  if (!archive) return { active: false, deferred: false };
  const source = plugins.filter(plugin => plugin.status === "archive" && plugin.kind === "directory" && plugin.reason === miaoReason);
  const canonical = source.find(plugin => plugin.path === "plugins/miao-plugin");
  for (const directory of canonical ? [canonical, ...source.filter(plugin => plugin !== canonical)] : source) {
    const file = await readMigrationSourceFile(archive, join(archive, basename(directory.path), "config/gacha.js"), gachaDisplayConfigBytes, signal);
    if (!file) continue;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    } catch {
      return { active: false, deferred: true };
    }
    const { config, deferred } = legacyGachaDisplayConfig(text);
    if (!Object.keys(config).length) return { active: false, deferred };
    const output = join(stage, "config");
    await mkdir(output, { mode: 0o700, recursive: true });
    if (!(await lstat(output)).isDirectory() || await realpath(output) !== output) throw new Error("抽卡设置暂存路径须为实体目录。");
    signal?.throwIfAborted();
    await writeFile(join(output, `${gachaDisplayConfigName}.yaml`), Bun.YAML.stringify(config), { flag: "wx", mode: 0o600 });
    return { active: true, deferred };
  }
  return { active: false, deferred: false };
}
