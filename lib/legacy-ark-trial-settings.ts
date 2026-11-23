import { readMigrationSourceFile, MigrationSourceFileError } from "./migration-files.ts";

export const legacyArkTrialFields = [
  ["profileChangeDiff", "show_difference"],
  ["DealLongDmgTitle", "long_title"],
] as const;
type LegacyKey = (typeof legacyArkTrialFields)[number][0];
type Setting = boolean | number;

/** Ark writes these settings as literal exports. Inspect those exports without executing any old plugin code. */
export async function readLegacyArkTrialSettings(root: string, path: string, fields: readonly (typeof legacyArkTrialFields[number])[], signal?: AbortSignal) {
  const config = new Map<LegacyKey, Setting | null>();
  try {
    const file = await readMigrationSourceFile(root, path, 256 * 1024, signal);
    if (!file) return config;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    const { exports } = new Bun.Transpiler({ loader: "js" }).scan(text);
    const source = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/gu,
      token => token.replace(/[^\r\n]/gu, token.startsWith("/") ? " " : "?"));
    for (const [key] of fields) {
      if (!exports.includes(key)) continue;
      const matches = [...source.matchAll(new RegExp(`^[ \\t]*export[ \\t]+const[ \\t]+${key}\\b([^\\r\\n]*)$`, "gmu"))];
      const literal = matches.length === 1 && /^\s*=\s*(true|false|[012])\s*;?\s*$/u.exec(matches[0]![1]!);
      const value = literal && literal[1];
      config.set(key, key === "profileChangeDiff"
        ? value === "true" ? true : value === "false" ? false : null
        : value && /^[012]$/u.test(value) ? Number(value) : null);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof MigrationSourceFileError && error.reason === "changed") throw error;
    for (const [key] of fields) config.set(key, null);
  }
  return config;
}
