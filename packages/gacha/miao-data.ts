import { parseDocument } from "yaml";

/** Old Miao schedules use literal flow collections inside JavaScript exports. */
export function readMiaoArrayExport(source: string, name: string): readonly unknown[] {
  const declaration = [...source.matchAll(/^export const ([a-zA-Z_][a-zA-Z_0-9]*)[ \t]*=[ \t]*/gmu)]
    .find((match) => match[1] === name);
  if (!declaration) return [];
  const literal = source.slice(declaration.index + declaration[0].length)
    .split(/^export\s/mu, 1)[0]!.trim().replace(/;$/u, "").trimEnd();
  if (!literal.startsWith("[") || !literal.endsWith("]")) return [];
  try {
    const document = parseDocument(literal, { schema: "failsafe", strict: true, uniqueKeys: true });
    if (document.errors.length || document.warnings.length) return [];
    const result: unknown = document.toJS({ maxAliasCount: 0 });
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}
