import { isMap, isScalar, parseDocument } from "yaml";

function exportLiteral(source: string, name: string) {
  const declaration = [...source.matchAll(/^export const ([a-zA-Z_][a-zA-Z_0-9]*)[ \t]*=[ \t]*/gmu)]
    .find((match) => match[1] === name);
  if (!declaration) return;
  return source.slice(declaration.index + declaration[0].length)
    .split(/^export\s/mu, 1)[0]!.trim().replace(/;$/u, "").trimEnd();
}

/** Old Miao schedules use literal flow collections inside JavaScript exports. */
export function readMiaoArrayExport(source: string, name: string): readonly unknown[] {
  const literal = exportLiteral(source, name);
  if (!literal?.startsWith("[") || !literal.endsWith("]")) return [];
  try {
    const document = parseDocument(literal, { schema: "failsafe", strict: true, uniqueKeys: true });
    if (document.errors.length || document.warnings.length) return [];
    const result: unknown = document.toJS({ maxAliasCount: 0 });
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

/** Weapon alias files contain quoted values and section comments. */
export function readMiaoObjectExport(source: string, name: string): Record<string, string> | undefined {
  const literal = exportLiteral(source, name)?.replace(/^[ \t]*\/\/.*$/gmu, "").trimEnd();
  if (!literal?.startsWith("{") || !literal.endsWith("}")) return;
  try {
    const document = parseDocument(literal, { schema: "failsafe", strict: true, uniqueKeys: true });
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) return;
    const entries: [string, string][] = [];
    for (const { key, value } of document.contents.items) {
      if (!isScalar(key) || typeof key.value !== "string" || !isScalar(value) || typeof value.value !== "string" ||
          (value.type !== "QUOTE_SINGLE" && value.type !== "QUOTE_DOUBLE")) return;
      entries.push([key.value, value.value]);
    }
    return Object.fromEntries(entries);
  } catch {
    return;
  }
}
