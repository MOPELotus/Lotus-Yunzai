/** Import before application modules: top-level labels must see the selected language at evaluation. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLanguage, registerLanguage, setLanguage, type LanguageCatalog } from "../packages/i18n/index.ts";

const maxBytes = 16 * 1024 * 1024;
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function directory(path: string) {
  let info;
  try { info = lstatSync(path); } catch (error) { if (missing(error)) return false; throw error; }
  if (!info.isDirectory() || realpathSync(path) !== path) throw new Error("Unsafe language catalog directory");
  return true;
}
function read(path: string): unknown {
  if (!directory(dirname(path))) return;
  let info;
  try { info = lstatSync(path); } catch (error) { if (missing(error)) return; throw error; }
  if (!info.isFile() || realpathSync(path) !== path || info.size > maxBytes) throw new Error("Unsafe language catalog file");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = fstatSync(descriptor);
    if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev) throw new Error("Language catalog changed while opening");
    const text = readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(text) > maxBytes) throw new Error("Language catalog is too large");
    return JSON.parse(text);
  } finally { closeSync(descriptor); }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function language(value: string) {
  if (!/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/u.test(value)) throw new Error("Invalid language tag");
  return new Intl.Locale(value.replaceAll("_", "-")).toString();
}

for (const parent of [join(root, "i18n/languages"), join(root, "config/i18n")]) {
  if (!directory(parent)) continue;
  for (const filename of readdirSync(parent).sort()) {
    if (!filename.endsWith(".json") || filename === "settings.json") continue;
    const tag = language(filename.slice(0, -5));
    const value = read(join(parent, filename));
    if (!object(value) || !object(value.messages) || value.language !== undefined && language(String(value.language)) !== tag) throw new Error("Invalid language catalog");
    registerLanguage(tag, value.messages as LanguageCatalog);
  }
}
const settings = read(join(root, "config/i18n/settings.json"));
if (object(settings) && typeof settings.language === "string") {
  try { setLanguage(language(settings.language)); }
  catch { setLanguage(defaultLanguage); }
}
