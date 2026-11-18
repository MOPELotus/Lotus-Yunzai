export async function readLocalConfig(root: URL, name: string): Promise<Record<string, unknown>> {
  for (const path of [`config/${name}.yaml`, `config/config/${name}.yaml`]) {
    const file = Bun.file(new URL(path, root));
    if (!await file.exists()) continue;

    try {
      const value: unknown = Bun.YAML.parse(await file.text());
      if (value === null || value === undefined) return {};
      if (typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new Error(`无法读取 ${path}。`);
    }
  }
  return {};
}
