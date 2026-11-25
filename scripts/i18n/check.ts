/** Validate editable copy catalogs; --prune removes only unused generated entries. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const prune = process.argv.includes("--prune");
const only = process.argv.find(value => value.startsWith("--unit="))?.slice(7);
const units = [".", "panel", ...["atlas", "execute", "genshin", "group", "guides", "media", "meme", "notice", "starrail", "zzz", "system"].map(name => `plugins/${name}`),
  ...["account", "captcha", "gacha", "hoyo-client", "skia", "storage"].map(name => `packages/${name}`)];
let total = 0, removed = 0;
for (const unit of units) {
  if (only && unit !== only) continue;
  const directory = resolve(root, unit), filename = resolve(directory, "i18n/zh-CN.json");
  if (!existsSync(filename)) continue;
  const catalog = JSON.parse(readFileSync(filename, "utf8"));
  if (catalog.language !== "zh-CN" || typeof catalog.description !== "string" || !catalog.sections || !catalog.parameters || !catalog.messages) throw new Error(`Invalid catalog metadata: ${unit}`);
  const references = new Set<string>();
  const calls = new Set<string>();
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: directory, encoding: "utf8" }).split("\n");
  for (const relative of files) {
    if (!/\.(?:ts|tsx|js|vue|html)$/u.test(relative) || /(?:^|\/)(?:i18n|internal|resources|node_modules|dist|test|tests)\//u.test(relative) || /\.test\./u.test(relative)) continue;
    if (unit === "." && !/^(?:app\.ts|lib\/|scripts\/|web\/)/u.test(relative)) continue;
    const path = resolve(directory, relative); if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/["'`]([A-Za-z0-9_.:-]+)["'`]/gu)) references.add(match[1]!);
    const namespace = /create(?:Text)?Translator\(\s*["']([^"']+)["']/u.exec(source)?.[1];
    if (namespace === undefined || namespace === catalog.namespace) {
      for (const match of source.matchAll(/(?:\$t_*|\bpanelText)\(\s*["']([A-Za-z0-9_.:-]+)["']\s*(?:,|\))/gu)) calls.add(match[1]!);
    }
  }
  for (const key of calls) if (!Object.hasOwn(catalog.messages, key)) throw new Error(`Missing message: ${unit}:${key}`);
  for (const [key, value] of Object.entries(catalog.messages)) {
    if (typeof value !== "string") throw new Error(`Invalid message: ${unit}:${key}`);
    if (!references.has(key)) {
      if (prune && /\.text_[a-f0-9]{10}$/u.test(key)) { delete catalog.messages[key]; delete catalog.parameters[key]; removed++; continue; }
      // Semantic keys can be selected dynamically (for example API status labels).
    }
    const section = Object.keys(catalog.sections).find(section => key === section || key.startsWith(section + "."));
    if (!section) throw new Error(`Missing function explanation: ${unit}:${key}`);
    const info = catalog.sections[section];
    if (typeof info.description !== "string" || !info.description || typeof info.source !== "string" || !info.source) throw new Error(`Invalid function explanation: ${unit}:${key}`);
    for (const name of Object.keys(catalog.parameters[key] ?? {})) {
      if (!value.includes(`{${name}}`)) throw new Error(`Missing parameter placeholder: ${unit}:${key}:${name}`);
    }
    total++;
  }
  for (const section of Object.keys(catalog.sections)) if (!Object.keys(catalog.messages).some(key => key === section || key.startsWith(section + "."))) delete catalog.sections[section];
  if (prune) writeFileSync(filename, JSON.stringify(catalog, null, 2) + "\n");
}
console.info(`i18n: ${total} messages checked; ${removed} unused entries removed.`);
