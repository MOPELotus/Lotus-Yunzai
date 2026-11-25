import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
export async function readLocalConfig(root: URL, name: string, legacyDefaults?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await readOptionalLocalConfig(root, name, legacyDefaults) ?? {};
}

export async function readOptionalLocalConfig(root: URL, name: string, legacyDefaults?: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const modern = await readOptionalConfigFile(root, `config/${name}.yaml`);
  if (modern !== undefined) return modern;
  const legacy = await readOptionalConfigFile(root, `config/config/${name}.yaml`);
  if (legacy !== undefined) return legacyDefaults ? { ...legacyDefaults, ...legacy } : legacy;
}

export async function readOptionalConfigFile(root: URL, path: string): Promise<Record<string, unknown> | undefined> {
  const file = Bun.file(new URL(path, root));
  if (!await file.exists()) return;
  try {
    const value: unknown = Bun.YAML.parse(await file.text());
    if (value === null || value === undefined) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error($t("lib.config.text_cafd49aeeb", { "path": path }));
  }
}

export function configuredIds(value: unknown): Set<number> {
  const entries = Array.isArray(value) ? value : [value];
  return new Set(entries.flatMap(entry => {
    const id = typeof entry === "string" && /^\d+$/u.test(entry.trim()) ? Number(entry) : entry;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? [id] : [];
  }));
}
