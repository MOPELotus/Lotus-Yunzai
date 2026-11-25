/** Load bundled text, user languages and private panel edits; never rewrite tracked catalogs. */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createI18n, defaultLanguage, type LanguageCatalog, type Messages } from "../packages/i18n/index.ts";
import * as shared from "../packages/i18n/index.ts";
import { lockFile } from "./file-lock.ts";

const maxBytes = 16 * 1024 * 1024;
const maxRequestBytes = 1024 * 1024;
type Runtime = Pick<ReturnType<typeof createI18n>, "createTranslator" | "registerLanguage" | "replaceLanguage" | "removeLanguage" | "getLanguage" | "setLanguage" | "listLanguages" | "getCatalog">;
type ObjectValue = Record<string, unknown>;
interface DefaultCatalog {
  readonly description: string;
  readonly sections: Readonly<Record<string, unknown>>;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly messages: Messages;
}
interface LanguageFile { readonly name: string; readonly messages: LanguageCatalog }
export interface I18nWriteGuard {
  readonly canWrite?: () => boolean;
  readonly canCommit?: () => boolean;
  readonly signal?: AbortSignal;
}
export class I18nSettingsError extends Error {
  constructor(readonly reason: "invalid" | "permission" | "cancelled" | "unsafe-path" | "too-large") {
    super(`Language settings: ${reason}`);
  }
}

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}
function locale(value: unknown): string {
  if (typeof value !== "string" || value.length > 80 || !/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/u.test(value)) throw new I18nSettingsError("invalid");
  try { return new Intl.Locale(value.replaceAll("_", "-")).toString(); }
  catch { throw new I18nSettingsError("invalid"); }
}
function messages(value: unknown): Record<string, string> {
  const source = object(value);
  if (!source) throw new I18nSettingsError("invalid");
  const result: Record<string, string> = Object.create(null);
  for (const [key, text] of Object.entries(source)) {
    if (!key || key.length > 300 || typeof text !== "string") throw new I18nSettingsError("invalid");
    result[key] = text;
  }
  return result;
}
function checkGuard(guard?: I18nWriteGuard) {
  if (guard?.signal?.aborted) throw new I18nSettingsError("cancelled");
  if (guard?.canWrite?.() === false || guard?.canCommit?.() === false) throw new I18nSettingsError("permission");
}
function noEntry(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

async function readRequestJson(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !== "application/json" || !request.body) throw new I18nSettingsError("invalid");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxRequestBytes) throw new I18nSettingsError("too-large");
      chunks.push(chunk.value);
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new I18nSettingsError("invalid"); }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function safeDirectory(path: string, create = false): Promise<boolean> {
  let info = await lstat(path).catch(error => { if (!noEntry(error)) throw error; });
  if (!info && create) {
    if (!await safeDirectory(dirname(path), true)) return false;
    await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    info = await lstat(path);
  }
  if (!info) return false;
  if (!info.isDirectory() || await realpath(path) !== path) throw new I18nSettingsError("unsafe-path");
  return true;
}

async function readJson(path: string): Promise<unknown | undefined> {
  if (!await safeDirectory(dirname(path))) return;
  const info = await lstat(path).catch(error => { if (!noEntry(error)) throw error; });
  if (!info) return;
  if (!info.isFile() || await realpath(path) !== path) throw new I18nSettingsError("unsafe-path");
  if (info.size > maxBytes) throw new I18nSettingsError("too-large");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await file.stat();
    if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev) throw new I18nSettingsError("unsafe-path");
    const text = await file.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(text) > maxBytes) throw new I18nSettingsError("too-large");
    try { return JSON.parse(text); } catch { throw new I18nSettingsError("invalid"); }
  } finally { await file.close(); }
}

async function atomicJson(path: string, value: unknown, guard?: I18nWriteGuard): Promise<void> {
  checkGuard(guard);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(text) > maxBytes) throw new I18nSettingsError("too-large");
  await safeDirectory(dirname(path), true);
  const previous = await lstat(path).catch(error => { if (!noEntry(error)) throw error; });
  if (previous && (!previous.isFile() || await realpath(path) !== path)) throw new I18nSettingsError("unsafe-path");
  const staged = join(dirname(path), `.i18n-${crypto.randomUUID()}.tmp`);
  try {
    const file = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    checkGuard(guard);
    await safeDirectory(dirname(path));
    const current = await lstat(path).catch(error => { if (!noEntry(error)) throw error; });
    if (current && (!current.isFile() || await realpath(path) !== path)) throw new I18nSettingsError("unsafe-path");
    await rename(staged, path);
    await chmod(path, 0o600);
  } finally { await rm(staged, { force: true }); }
}

/** Each instance can use an isolated runtime in tests; the application shares one instance per root. */
export function createI18nSettings(root: URL, { runtime = shared, onChanged }: {
  readonly runtime?: Runtime;
  readonly onChanged?: () => void;
} = {}) {
  const directory = resolve(fileURLToPath(root));
  const defaults: Record<string, DefaultCatalog> = Object.create(null);
  const labels = new Map<string, string>([[defaultLanguage, defaultLanguage]]);
  const overrides = new Map<string, LanguageCatalog>();
  let managedLanguages = new Map<string, LanguageFile>();
  let scannedUserLanguages = false;
  let chineseLabel = defaultLanguage;
  let loaded: Promise<void> | undefined;
  let mutation: Promise<unknown> = Promise.resolve();
  let restartRequired = false;

  function validateKnown(catalogs: LanguageCatalog): void {
    for (const [namespace, values] of Object.entries(catalogs)) {
      const source = defaults[namespace]?.messages;
      if (!source) throw new I18nSettingsError("invalid");
      for (const key of Object.keys(values)) if (!Object.hasOwn(source, key)) throw new I18nSettingsError("invalid");
    }
  }

  async function loadDefault(path: string, fallbackNamespace: string): Promise<void> {
    const value = await readJson(path);
    if (value === undefined) return;
    const doc = object(value);
    if (!doc) throw new I18nSettingsError("invalid");
    const hasMessages = Object.hasOwn(doc, "messages");
    const namespace = hasMessages && typeof doc.namespace === "string" ? doc.namespace : fallbackNamespace;
    if (!/^[a-z][a-z0-9._-]{0,79}$/u.test(namespace) || Object.hasOwn(defaults, namespace)) throw new I18nSettingsError("invalid");
    const content = messages(hasMessages ? doc.messages : doc);
    defaults[namespace] = {
      description: typeof doc.description === "string" ? doc.description : "",
      sections: object(doc.sections) ?? {}, parameters: object(doc.parameters) ?? {}, messages: content,
    };
    runtime.createTranslator(namespace, content);
    if (namespace === "core" && typeof doc.name === "string") { chineseLabel = doc.name; labels.set(defaultLanguage, doc.name); }
  }

  function parseLanguage(value: unknown, tag: string): LanguageFile {
    const doc = object(value);
    const catalog = object(doc?.messages);
    if (!doc || !catalog || doc.language !== undefined && locale(doc.language) !== tag) throw new I18nSettingsError("invalid");
    const parsed: Record<string, Messages> = Object.create(null);
    for (const [namespace, values] of Object.entries(catalog)) parsed[namespace] = messages(values);
    validateKnown(parsed);
    return { name: typeof doc.name === "string" && doc.name.length <= 160 ? doc.name : tag, messages: parsed };
  }

  async function languageFiles(path: string): Promise<Map<string, LanguageFile>> {
    const result = new Map<string, LanguageFile>();
    if (!await safeDirectory(path)) return result;
    for (const entry of (await readdir(path)).sort()) {
      if (!entry.endsWith(".json") || entry === "settings.json") continue;
      const tag = locale(entry.slice(0, -5));
      const value = await readJson(join(path, entry));
      if (value === undefined) continue;
      result.set(tag, parseLanguage(value, tag));
    }
    return result;
  }

  async function refreshUserLanguages() {
    // Stage both directories completely before replacing the in-memory view.
    const shipped = await languageFiles(join(directory, "i18n/languages"));
    const edited = await languageFiles(join(directory, "config/i18n"));
    const combined = new Map(shipped);
    for (const [tag, language] of edited) {
      const before = combined.get(tag);
      const messages: Record<string, Messages> = Object.create(null);
      for (const [namespace, entries] of Object.entries(before?.messages ?? {})) messages[namespace] = entries;
      for (const [namespace, entries] of Object.entries(language.messages)) messages[namespace] = { ...messages[namespace], ...entries };
      combined.set(tag, { name: language.name, messages });
    }
    const before = scannedUserLanguages ? JSON.stringify(runtime.getCatalog()) : undefined;
    for (const tag of managedLanguages.keys()) if (!combined.has(tag)) runtime.removeLanguage(tag);
    for (const [tag, language] of combined) runtime.replaceLanguage(tag, language.messages);
    managedLanguages = combined;
    overrides.clear();
    for (const [tag, language] of edited) overrides.set(tag, language.messages);
    labels.clear();
    labels.set(defaultLanguage, chineseLabel);
    for (const [tag, language] of combined) labels.set(tag, language.name);
    if (before !== undefined && before !== JSON.stringify(runtime.getCatalog())) restartRequired = true;
    scannedUserLanguages = true;
  }

  function load(): Promise<void> {
    return loaded ??= (async () => {
      await safeDirectory(directory);
      await loadDefault(join(directory, "i18n/zh-CN.json"), "core");
      const textDirectory = join(directory, "i18n");
      if (await safeDirectory(textDirectory)) {
        for (const child of await readdir(textDirectory, { withFileTypes: true })) {
          if (child.isDirectory() && child.name !== "languages") await loadDefault(join(textDirectory, child.name, "zh-CN.json"), child.name);
        }
      }
      for (const category of ["packages", "plugins"]) {
        const parent = join(directory, category);
        if (!await safeDirectory(parent)) continue;
        for (const child of await readdir(parent, { withFileTypes: true })) {
          if (!child.isDirectory()) continue;
          await loadDefault(join(parent, child.name, "i18n/zh-CN.json"), child.name);
        }
      }
      await loadDefault(join(directory, "panel/i18n/zh-CN.json"), "panel");
      await refreshUserLanguages();
      const settings = object(await readJson(join(directory, "config/i18n/settings.json")));
      if (settings?.language !== undefined) {
        const requested = locale(settings.language);
        if (runtime.listLanguages().includes(requested)) runtime.setLanguage(requested);
      }
    })().catch(error => { loaded = undefined; throw error; });
  }

  function snapshotValue() {
    const language = runtime.getLanguage();
    return {
      language,
      restartRequired,
      languages: runtime.listLanguages().map(id => ({ id, label: labels.get(id) ?? id })),
      catalogs: runtime.getCatalog(language), defaults: structuredClone(defaults),
      overrides: structuredClone(overrides.get(language) ?? {}),
    };
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutation.catch(() => undefined).then(operation);
    mutation = result;
    return result;
  }

  function snapshot() {
    return serialize(async () => { await load(); await refreshUserLanguages(); return snapshotValue(); });
  }

  async function editMessages({ language, namespace, messages: input }: {
    readonly language: unknown; readonly namespace: unknown; readonly messages: unknown;
  }, guard?: I18nWriteGuard) {
    return serialize(async () => {
      checkGuard(guard);
      await load();
      await refreshUserLanguages();
      const tag = locale(language);
      if (typeof namespace !== "string" || !Object.hasOwn(defaults, namespace)) throw new I18nSettingsError("invalid");
      const changes = messages(input);
      validateKnown({ [namespace]: changes });
      const path = join(directory, "config/i18n", `${tag}.json`);
      await safeDirectory(dirname(path), true);
      const lock = await lockFile(join(dirname(path), ".i18n-write.sqlite"), "Language settings");
      try {
        checkGuard(guard);
        const previous = await readJson(path);
        const before = previous === undefined ? { name: labels.get(tag) ?? tag, messages: {} } : parseLanguage(previous, tag);
        const next = { ...before, messages: { ...before.messages, [namespace]: { ...before.messages[namespace], ...changes } } };
        await atomicJson(path, next, guard);
        await refreshUserLanguages();
        restartRequired = true;
        onChanged?.();
        return snapshotValue();
      } finally { lock.close(); }
    });
  }

  async function setLanguage(language: unknown, guard?: I18nWriteGuard) {
    return serialize(async () => {
      checkGuard(guard);
      await load();
      await refreshUserLanguages();
      const tag = locale(language);
      if (!runtime.listLanguages().includes(tag)) throw new I18nSettingsError("invalid");
      const path = join(directory, "config/i18n/settings.json");
      await safeDirectory(dirname(path), true);
      const lock = await lockFile(join(dirname(path), ".i18n-write.sqlite"), "Language settings");
      try {
        await atomicJson(path, { language: tag }, guard);
        runtime.setLanguage(tag);
        restartRequired = true;
        onChanged?.();
        return snapshotValue();
      } finally { lock.close(); }
    });
  }

  return { load, snapshot, setLanguage, editMessages };
}

export type I18nSettings = ReturnType<typeof createI18nSettings>;
const instances = new Map<string, I18nSettings>();
export function getI18nSettings(root: URL): I18nSettings {
  const key = resolve(fileURLToPath(root));
  let instance = instances.get(key);
  if (!instance) { instance = createI18nSettings(root); instances.set(key, instance); }
  return instance;
}

/** Existing panel owner authorization is checked both at entry and immediately before saving. */
export function panelI18n(root: URL | I18nSettings) {
  const settings = root instanceof URL ? getI18nSettings(root) : root;
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (!["GET", "PUT", "PATCH"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, PUT, PATCH" } });
    try {
      if (request.method === "GET") {
        const value = await settings.snapshot();
        return active() ? Response.json(value) : new Response(null, { status: 401 });
      }
      let body: ObjectValue | undefined;
      body = object(await readRequestJson(request));
      if (!body) throw new I18nSettingsError("invalid");
      const guard = { canWrite: active, canCommit: active, signal: request.signal };
      if (request.method === "PUT") {
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "language")) throw new I18nSettingsError("invalid");
        return Response.json(await settings.setLanguage(body.language, guard));
      }
      if (Object.keys(body).length !== 3 || !["language", "namespace", "messages"].every(key => Object.hasOwn(body, key))) throw new I18nSettingsError("invalid");
      return Response.json(await settings.editMessages({ language: body.language, namespace: body.namespace, messages: body.messages }, guard));
    } catch (error) {
      if (error instanceof I18nSettingsError) {
        const status = error.reason === "permission" || error.reason === "cancelled" ? 401 : error.reason === "too-large" ? 413 : 400;
        return Response.json({ error: error.reason }, { status });
      }
      return new Response(null, { status: 500 });
    }
  };
}
