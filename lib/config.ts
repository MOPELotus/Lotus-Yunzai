export async function readLocalConfig(root: URL, name: string): Promise<Record<string, unknown>> {
  return await readOptionalLocalConfig(root, name) ?? {};
}

export async function readOptionalLocalConfig(root: URL, name: string): Promise<Record<string, unknown> | undefined> {
  for (const path of [`config/${name}.yaml`, `config/config/${name}.yaml`]) {
    const value = await readOptionalConfigFile(root, path);
    if (value !== undefined) return value;
  }
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
    throw new Error(`无法读取 ${path}。`);
  }
}

export function configuredIds(value: unknown): Set<number> {
  const entries = Array.isArray(value) ? value : [value];
  return new Set(entries.flatMap(entry => {
    const id = typeof entry === "string" && /^\d+$/u.test(entry.trim()) ? Number(entry) : entry;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? [id] : [];
  }));
}
