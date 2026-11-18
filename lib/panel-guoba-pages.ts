import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

const pageDirectories = ["guoba", "webadapter"] as const;
const descriptorFiles = ["index.js", "pages.js", "pages.json", "page.js", "page.json"] as const;
const pageIdPattern = /^[A-Za-z0-9_-]+$/u;
const assetExtensions = new Set([
  ".html", ".js", ".css", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".woff", ".woff2", ".ttf", ".map",
]);

export interface GuobaPage {
  readonly id: string;
  readonly plugin: string;
  readonly title: string;
  readonly icon?: string;
  readonly usePluginIcon: boolean;
  readonly priority: number;
  readonly html?: string;
  readonly src?: string;
  readonly style?: string;
  readonly script?: string;
}

interface GuobaPageIssue {
  readonly plugin: string;
  readonly kind: "unsupported-js" | "invalid" | "duplicate-id";
  readonly descriptor?: typeof descriptorFiles[number];
  readonly id?: string;
}

interface GuobaAsset {
  readonly path: string;
  readonly isEntry: boolean;
}

export interface GuobaPages {
  readonly pages: readonly GuobaPage[];
  readonly issues: readonly GuobaPageIssue[];
  resolveAsset(pageId: string, resource: string): Promise<GuobaAsset | undefined>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contained(directory: string, path: string): boolean {
  const part = relative(directory, path);
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function findPageDirectory(pluginDirectory: string): Promise<string | undefined> {
  if (!isAbsolute(pluginDirectory)) throw new Error();
  const plugin = await realpath(pluginDirectory);
  for (const name of pageDirectories) {
    const candidate = join(plugin, name);
    if (!await exists(candidate)) continue;
    const directory = await realpath(candidate);
    if (!contained(plugin, directory)) throw new Error();
    if ((await stat(directory)).isDirectory()) return directory;
  }
}

async function findDescriptor(directory: string): Promise<typeof descriptorFiles[number] | undefined> {
  for (const filename of descriptorFiles) {
    if (await exists(join(directory, filename))) return filename;
  }
}

async function containedFile(directory: string, filename: string): Promise<string> {
  const path = await realpath(join(directory, filename));
  if (!contained(directory, path) || !(await stat(path)).isFile()) throw new Error();
  return path;
}

function manifestPages(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (!record(value)) throw new Error();
  if (!Object.hasOwn(value, "pages")) return [value];
  if (!Array.isArray(value.pages)) throw new Error();
  return value.pages;
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") throw new Error();
  return value;
}

function resourceName(value: unknown): string | undefined {
  const resource = optionalText(value);
  if (resource === undefined) return;
  if (isAbsolute(resource) || /^[A-Za-z][\w+.-]*:/u.test(resource) || /[\\\0?#]/u.test(resource) ||
      resource.includes("..") || resource.split("/").some((part) => part === "" || part === ".") ||
      !assetExtensions.has(extname(resource).toLowerCase())) {
    throw new Error();
  }
  return resource;
}

async function normalisePage(plugin: string, directory: string, definition: unknown): Promise<GuobaPage> {
  if (!record(definition)) throw new Error();
  const { id, title } = definition;
  if (typeof id !== "string" || !pageIdPattern.test(id) || id === "manage" ||
      typeof title !== "string" || !title.trim()) throw new Error();

  const src = resourceName(definition.src);
  const style = resourceName(definition.style);
  const script = resourceName(definition.script);
  const html = src === undefined ? optionalText(definition.html) : undefined;
  if (src === undefined && html === undefined) throw new Error();
  for (const resource of [src, style, script]) {
    if (resource !== undefined) await containedFile(directory, resource);
  }
  const numeric = Number(definition.priority);
  return Object.freeze({
    id, plugin, title,
    icon: optionalText(definition.icon),
    usePluginIcon: definition.usePluginIcon === true,
    priority: Number.isFinite(numeric) && numeric !== 0 ? numeric : 100,
    html, src, style, script,
  });
}

export async function loadGuobaPages(pluginDirectories: ReadonlyMap<string, string>): Promise<GuobaPages> {
  const registry = new Map<string, { page: GuobaPage; directory: string }>();
  const issues: GuobaPageIssue[] = [];
  for (const [plugin, pluginDirectory] of pluginDirectories) {
    let descriptor: typeof descriptorFiles[number] | undefined;
    try {
      const directory = await findPageDirectory(pluginDirectory);
      if (directory === undefined) continue;
      descriptor = await findDescriptor(directory);
      if (descriptor === undefined) continue;
      if (descriptor.endsWith(".js")) {
        issues.push({ plugin, descriptor, kind: "unsupported-js" });
        continue;
      }
      const input = await readFile(await containedFile(directory, descriptor), "utf8");
      for (const definition of manifestPages(JSON.parse(input.replace(/^\uFEFF/u, "")))) {
        try {
          const page = await normalisePage(plugin, directory, definition);
          if (registry.has(page.id)) issues.push({ plugin, descriptor, id: page.id, kind: "duplicate-id" });
          else registry.set(page.id, { page, directory });
        } catch {
          issues.push({ plugin, descriptor, kind: "invalid" });
        }
      }
    } catch {
      issues.push({ plugin, descriptor, kind: "invalid" });
    }
  }

  return {
    pages: [...registry.values()].map(({ page }) => page).sort((left, right) => left.priority - right.priority),
    issues,
    async resolveAsset(pageId, resource) {
      const entry = registry.get(pageId);
      if (entry === undefined || !resource || ![entry.page.src, entry.page.style, entry.page.script].includes(resource)) return;
      try {
        const path = await containedFile(entry.directory, resource);
        return { path, isEntry: entry.page.src === resource };
      } catch {
        return undefined;
      }
    },
  };
}
