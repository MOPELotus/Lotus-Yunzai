import { addAbortListener } from "node:events";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validGuobaApiRoute, type GuobaApiDefinition, type GuobaApiHandler } from "./panel-guoba-http.ts";
import { defaultPluginLoadMs } from "./plugin-load-progress.ts";

const pageDirectories = ["guoba", "webadapter"] as const;
const descriptorFiles = ["index.js", "pages.js", "pages.json", "page.js", "page.json"] as const;
const pageIdPattern = /^[A-Za-z0-9_-]+$/u;
const apiMethods = new Set(["get", "post", "put", "delete", "patch", "all"]);
const moduleCache = createRequire(import.meta.url).cache;
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
  readonly kind: "invalid" | "duplicate-id";
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
  readonly apis: ReadonlyMap<string, readonly GuobaApiDefinition[]>;
  resolveAsset(pageId: string, resource: string): Promise<GuobaAsset | undefined>;
}

export interface ExternalGuobaPage {
  readonly plugin: string;
  readonly directory: string;
  readonly definition: Omit<GuobaPage, "plugin" | "usePluginIcon">;
  readonly apis: readonly GuobaApiDefinition[];
  readonly servicePreview?: boolean;
}

export interface GuobaPageScanOptions {
  readonly loadTimeout?: number;
  readonly signal?: AbortSignal;
}

interface ScannedPlugin {
  readonly directory?: string;
  readonly descriptor?: typeof descriptorFiles[number];
  readonly pages?: readonly GuobaPage[];
  readonly apis?: readonly GuobaApiDefinition[];
  readonly issues?: readonly GuobaPageIssue[];
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

function normaliseApi(method: unknown, route: unknown, handlers: readonly unknown[]): GuobaApiDefinition {
  const verb = method === undefined || method === null || method === "" ? "get" : method;
  if (typeof verb !== "string" || !apiMethods.has(verb.toLowerCase()) ||
      typeof route !== "string" || !validGuobaApiRoute(route) ||
      !handlers.length || !handlers.every((handler) => typeof handler === "function")) throw new Error();

  const path = route === "/" ? route : route.replace(/\/$/u, "");
  return Object.freeze({ method: verb.toLowerCase(), route: path, handlers: Object.freeze(handlers as GuobaApiHandler[]) });
}

function extensionLogger(plugin: string) {
  const tag = `[锅巴扩展] ${plugin}`;
  return Object.freeze({
    trace: (...values: unknown[]) => console.debug(tag, ...values),
    debug: (...values: unknown[]) => console.debug(tag, ...values),
    info: (...values: unknown[]) => console.info(tag, ...values),
    mark: (...values: unknown[]) => console.info(tag, ...values),
    warn: (...values: unknown[]) => console.warn(tag, ...values),
    error: (...values: unknown[]) => console.error(tag, ...values),
    fatal: (...values: unknown[]) => console.error(tag, ...values),
  });
}

async function loadDescriptor(plugin: string, directory: string, descriptor: string, reload: boolean, signal: AbortSignal) {
  const file = await containedFile(directory, descriptor);
  signal.throwIfAborted();
  if (!descriptor.endsWith(".js")) {
    const input = await readFile(file, { encoding: "utf8", signal });
    return { definitions: manifestPages(JSON.parse(input.replace(/^\uFEFF/u, ""))) };
  }

  // Bun resolves query strings on file imports to the same module cache key.
  if (reload) delete moduleCache[file];
  const { default: pages, pages: named, init } = await import(pathToFileURL(file).href);
  signal.throwIfAborted();
  if (typeof init !== "function") {
    const exported: unknown = pages ?? named;
    return { definitions: exported === undefined || exported === null ? [] : manifestPages(exported) };
  }

  const definitions: unknown[] = [];
  const registeredApis = new Map<string, GuobaApiDefinition>();
  let accepting = true;
  function registerPage(definition: unknown) {
    if (accepting && !signal.aborted) definitions.push(record(definition) ? { ...definition } : definition);
  }
  try {
    await init(Object.freeze({
      pluginName: plugin,
      pluginDir: directory,
      basePath: "/guoba",
      apiBase: `/guoba/api/custom/${encodeURIComponent(plugin)}`,
      logger: extensionLogger(plugin),
      signal,
      registerPage,
      registerPages(value: unknown) {
        if (accepting && !signal.aborted) for (const definition of manifestPages(value)) registerPage(definition);
      },
      registerApi(method: unknown, route: unknown, ...handlers: unknown[]) {
        if (!accepting || signal.aborted) return;
        const api = normaliseApi(method, route, handlers);
        const key = `${api.method} ${api.route}`;
        if (!registeredApis.has(key)) registeredApis.set(key, api);
      },
    }));
  } finally {
    accepting = false;
  }
  return { definitions, registeredApis: [...registeredApis.values()] };
}

async function scanPlugin(
  plugin: string, pluginDirectory: string, reload: boolean, external: ExternalGuobaPage | undefined,
  { loadTimeout = defaultPluginLoadMs, signal: shutdown }: GuobaPageScanOptions,
): Promise<ScannedPlugin> {
  const deadline = new AbortController();
  const signal = shutdown ? AbortSignal.any([shutdown, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), loadTimeout);
  timer.unref();
  const interrupted = Promise.withResolvers<never>();
  const cancellation = addAbortListener(signal, () => interrupted.reject(signal.reason));
  let descriptor: typeof descriptorFiles[number] | undefined;
  const loading = (async (): Promise<ScannedPlugin> => {
    signal.throwIfAborted();
    const directory = await findPageDirectory(pluginDirectory);
    signal.throwIfAborted();
    if (directory === undefined) return {};
    descriptor = external ? undefined : await findDescriptor(directory);
    signal.throwIfAborted();
    if (!external && !descriptor) return {};

    const { definitions, registeredApis } = external ? { definitions: [external.definition], registeredApis: external.apis }
      : await loadDescriptor(plugin, directory, descriptor!, reload, signal);
    const pages: GuobaPage[] = [];
    const issues: GuobaPageIssue[] = [];
    for (const definition of definitions) {
      signal.throwIfAborted();
      try {
        pages.push(await normalisePage(plugin, directory, definition));
      } catch (error) {
        if (registeredApis !== undefined) throw error;
        issues.push({ plugin, descriptor, kind: "invalid" });
      }
    }
    return { directory, descriptor, pages, apis: registeredApis, issues };
  })();
  try {
    return await Promise.race([loading, interrupted.promise]);
  } catch {
    return { issues: [{ plugin, descriptor, kind: "invalid" }] };
  } finally {
    clearTimeout(timer);
    cancellation[Symbol.dispose]();
  }
}

export async function loadGuobaPages(
  pluginDirectories: ReadonlyMap<string, string>, reload = false, external?: ExternalGuobaPage,
  options: GuobaPageScanOptions = {},
): Promise<GuobaPages> {
  const registry = new Map<string, { page: GuobaPage; directory: string }>();
  const apis = new Map<string, readonly GuobaApiDefinition[]>();
  const issues: GuobaPageIssue[] = [];
  const sources = external ? new Map(pluginDirectories).set(external.plugin, external.directory) : pluginDirectories;
  const scanned = await Promise.all([...sources].map(async ([plugin, path]) => ({
    plugin,
    ...await scanPlugin(plugin, path, reload, external?.plugin === plugin ? external : undefined, options),
  })));
  // Merge completed scans in source order, preserving the original duplicate ID winner.
  for (const { plugin, directory, descriptor, pages, apis: routes, issues: pluginIssues } of scanned) {
    if (pluginIssues) issues.push(...pluginIssues);
    if (!directory) continue;
    for (const page of pages ?? []) {
      if (registry.has(page.id)) issues.push({ plugin, descriptor, id: page.id, kind: "duplicate-id" });
      else registry.set(page.id, { page, directory });
    }
    if (routes?.length) apis.set(plugin, Object.freeze(routes));
  }

  return {
    pages: [...registry.values()].map(({ page }) => page).sort((left, right) => left.priority - right.priority),
    issues,
    apis,
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
