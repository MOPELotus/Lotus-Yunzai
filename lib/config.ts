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

export async function readOtherSetting(root: URL, key: string): Promise<
  { readonly primary: unknown } | { readonly legacy: Readonly<Record<string, unknown>> } | undefined
> {
  const primary = await readOptionalConfigFile(root, "config/other.yaml");
  if (primary && Object.hasOwn(primary, key)) return { primary: primary[key] };
  const legacy = await readOptionalConfigFile(root, "config/config/other.yaml").catch(error => {
    if (!primary) throw error;
    return undefined;
  });
  // TRSS applied the bundled deny lists before its runtime overlay.
  if (legacy) return { legacy: { blackGroup: [213_938_015], blackUser: [528_952_540], ...legacy, ...primary } };
}

export function configuredIds(value: unknown): Set<number> {
  const entries = Array.isArray(value) ? value : [value];
  return new Set(entries.flatMap(entry => {
    const id = typeof entry === "string" && /^\d+$/u.test(entry.trim()) ? Number(entry) : entry;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? [id] : [];
  }));
}
