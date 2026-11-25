import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";
import { keepMemeCatalogDenials, scanMemeCatalogExclusions } from "../plugins/meme/catalog-exclusions.ts";
import { safeCatalogKey } from "../plugins/meme/catalog-policy.ts";
import { isExcludedMemeTemplate } from "../plugins/meme/template-policy.ts";

const mergedMemePlugin = rejectionReason(["meme-plugin"], []);
const databaseLimit = 32 * 1024 * 1024;
const yamlLimit = 256 * 1024;
const dataRowLimit = 10_000;
const localFields = {
  meme: ["enable", "forceSharp", "cache", "reply", "userName", "imagesInMessage", "quotedImages", "errorReply"],
  access: ["enable", "mode", "userWhiteList", "userBlackList", "blackListEnable", "blackList"],
  protect: ["list", "user", "enable", "master", "userEnable"],
  stat: ["enable"],
  server: ["managedTimeout"],
} as const;

type Preset = [name: string, key: string, option: string, value: string, created: string, updated: string];
type Statistic = [key: string, count: number];

function text(value: unknown, max = 1024): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}

function allowedSetting(key: string, value: unknown) {
  if (key === "managedTimeout") return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 120;
  if (key === "mode") return value === 0 || value === 1;
  if (["userWhiteList", "userBlackList", "blackList", "user", "list"].includes(key)) {
    const valid = (item: unknown) => text(item, 512) || typeof item === "number" && Number.isSafeInteger(item) && item > 0;
    return Array.isArray(value) ? value.every(valid) : key === "user" && valid(value);
  }
  return typeof value === "boolean";
}

function rows(database: Database) {
  const table = (name: string) => database.query("SELECT 1 FROM sqlite_schema WHERE name = ? AND type = 'table'").get(name);
  const scanned = table("meme") ? scanMemeCatalogExclusions(database) : undefined;
  const denied = scanned?.keys ?? new Set<string>();
  if (table("lotus_catalog_denied_keys")) {
    for (const { key } of database.query<{ key: unknown }, []>("SELECT key FROM lotus_catalog_denied_keys").iterate()) {
      if (safeCatalogKey(key) && !scanned?.correctedArchiveKeys.has(key)) denied.add(key);
    }
  }
  const presets: Preset[] = [];
  const statistics: Statistic[] = [];
  if (table("preset")) {
    let rowCount = 0;
    for (const row of database.query<{
      name: unknown; key: unknown; arg_name: unknown; arg_value: unknown; createdAt: unknown; updatedAt: unknown;
    }, [number]>("SELECT name, key, arg_name, arg_value, createdAt, updatedAt FROM preset LIMIT ?").iterate(dataRowLimit + 1)) {
      if (++rowCount > dataRowLimit) throw new Error($t("lib.migration-meme-state.text_a1a99c4905"));
      const { name, key, arg_name, arg_value, createdAt, updatedAt } = row;
      if (!text(name) || !safeCatalogKey(key) || !text(arg_name, 256) || !text(arg_value) ||
          !text(createdAt, 128) || !text(updatedAt, 128) || denied.has(key) || isExcludedMemeTemplate(key)) continue;
      let keyword: unknown;
      try { keyword = JSON.parse(name); } catch { continue; }
      if (typeof keyword === "string" && keyword.trim()) presets.push([name, key, arg_name, arg_value, createdAt, updatedAt]);
    }
  }
  if (table("stat")) {
    let rowCount = 0;
    for (const { key, count } of database.query<{ key: unknown; count: unknown }, [number]>(
      'SELECT key, "all" AS count FROM stat LIMIT ?',
    ).iterate(dataRowLimit + 1)) {
      if (++rowCount > dataRowLimit) throw new Error($t("lib.migration-meme-state.text_a1a99c4905"));
      if (safeCatalogKey(key) && !denied.has(key) && !isExcludedMemeTemplate(key) &&
          typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
        statistics.push([key, count]);
      }
    }
  }
  return { presets, statistics, denied };
}

async function readDatabase(directory: string, state: string, signal?: AbortSignal) {
  const local = join(directory, "data/data.db");
  const file = await readMigrationSourceFile(directory, local, databaseLimit, signal);
  if (!file) return;
  const temporary = await mkdtemp(join(state, ".meme-source-"));
  try {
    const target = join(temporary, "data.db");
    await writeFile(target, file.bytes, { mode: 0o600, flag: "wx" });
    for (const suffix of ["-wal", "-journal"]) {
      const companion = await readMigrationSourceFile(directory, local + suffix, databaseLimit, signal);
      if (companion?.bytes.length) await writeFile(target + suffix, companion.bytes, { mode: 0o600, flag: "wx" });
    }
    using database = new Database(target, { readonly: false, create: false });
    database.exec("PRAGMA trusted_schema = OFF");
    return rows(database);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function stageDatabase(data: ReturnType<typeof rows>, destination: string) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const path = join(destination, "data.db");
  await writeFile(path, "", { flag: "wx", mode: 0o600 });
  using database = new Database(path, { create: false });
  database.exec(`
    CREATE TABLE preset (name JSON PRIMARY KEY NOT NULL, key TEXT NOT NULL, arg_name TEXT NOT NULL, arg_value TEXT NOT NULL,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL);
    CREATE TABLE stat (key TEXT PRIMARY KEY NOT NULL, "all" INTEGER NOT NULL);
  `);
  const putPreset = database.query("INSERT OR IGNORE INTO preset VALUES (?, ?, ?, ?, ?, ?)");
  const putCount = database.query("INSERT OR IGNORE INTO stat VALUES (?, ?)");
  database.transaction(() => {
    for (const row of data.presets) putPreset.run(...row);
    for (const row of data.statistics) putCount.run(...row);
    keepMemeCatalogDenials(database, data.denied);
  })();
}

export async function stageLegacyMemeState(archive: string | undefined, state: string, entries: readonly LegacyPluginPlanEntry[],
  signal?: AbortSignal,
) {
  const report = { settings: 0, presets: 0, statistics: 0, deferred: false };
  if (!archive) return report;
  const source = entries.find(entry => entry.status === "archive" && entry.kind === "directory" &&
    entry.reason === mergedMemePlugin && entry.path === "plugins/meme-plugin") ??
    entries.find(entry => entry.status === "archive" && entry.kind === "directory" && entry.reason === mergedMemePlugin);
  if (!source) return report;
  const directory = join(archive, basename(source.path));
  const destination = join(state, "data/meme");
  for (const [file, fields] of Object.entries(localFields)) {
    let config: Record<string, unknown>;
    try {
      const filePath = join(directory, "config/config", file + ".yaml");
      const snapshot = await readMigrationSourceFile(directory, filePath, yamlLimit, signal);
      if (!snapshot) continue;
      const parsed: unknown = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes));
      if (parsed == null) continue;
      if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error($t("lib.migration-meme-state.text_19c1dd1739"));
      config = parsed as Record<string, unknown>;
    } catch {
      signal?.throwIfAborted();
      report.deferred = true;
      continue;
    }
    const kept = Object.fromEntries(fields.flatMap(field => {
      if (!Object.hasOwn(config, field)) return [];
      if (allowedSetting(field, config[field])) return [[field, config[field]]];
      report.deferred = true;
      return [];
    }));
    if (!Object.keys(kept).length) continue;
    await mkdir(join(destination, "config"), { recursive: true, mode: 0o700 });
    await writeFile(join(destination, "config", file + ".yaml"), Bun.YAML.stringify(kept), { flag: "wx", mode: 0o600 });
    report.settings++;
  }
  let data: Awaited<ReturnType<typeof readDatabase>>;
  try { data = await readDatabase(directory, state, signal); }
  catch {
    signal?.throwIfAborted();
    report.deferred = true;
  }
  if (data && (data.presets.length || data.statistics.length || data.denied.size)) {
    signal?.throwIfAborted();
    await stageDatabase(data, destination);
    report.presets = data.presets.length;
    report.statistics = data.statistics.length;
  }
  return report;
}
