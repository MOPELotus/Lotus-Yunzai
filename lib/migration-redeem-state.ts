import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { REDEEM_GAMES } from "../packages/hoyo-client/redeem-preview/games.ts";
import { legacyLotusDirectories } from "./lotus-global-config.ts";

const stores = ["data", ...legacyLotusDirectories.map(id => `plugins/${id}/data`)];
const marker = "__lotusPreviewJournalVersion";
const batchKey = /^[a-f0-9]{64}$/u;
const activityId = /^[a-zA-Z0-9_-]{1,80}$/u;
const historyLimit = 12;
const journalMaxBytes = 16 * 1024 * 1024;
const activitiesMaxBytes = 32 * 1024;
const journalFile = "auto.json";
const activitiesFile = "activities.json";

interface Entry {
  readonly time: number;
  readonly status: "started" | "finished";
}

function mapping(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseEntry(value: unknown): Entry {
  if (!mapping(value) || typeof value.time !== "number" || !Number.isSafeInteger(value.time) || value.time < 0 ||
      (value.status !== "started" && value.status !== "finished")) throw new Error($t("lib.migration-redeem-state.text_0e7d23f5eb"));
  return { time: value.time, status: value.status };
}

function within(parent: string, file: string) {
  const path = relative(parent, file);
  return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

async function optionalStat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sameFile(expected: Stats, actual: Stats | undefined) {
  return actual !== undefined && expected.dev === actual.dev && expected.ino === actual.ino &&
    expected.size === actual.size && expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs;
}

function changed() {
  return new Error($t("lib.migration-redeem-state.text_939ab4eb53"));
}

async function readFrozen(path: string, maxBytes: number, inventory: Map<string, Stats | undefined>) {
  const expected = await optionalStat(path);
  inventory.set(path, expected);
  if (!expected) return;
  if (!expected.isFile() || expected.nlink !== 1 || expected.size > maxBytes || await realpath(path) !== path) {
    throw new Error($t("lib.migration-redeem-state.text_655c663d39"));
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(expected, await file.stat())) throw changed();
    const buffer = Buffer.alloc(expected.size);
    for (let offset = 0; offset < buffer.length;) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    if (!sameFile(expected, await file.stat()) || await realpath(path) !== path) throw changed();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer)); }
    catch { throw new Error($t("lib.migration-redeem-state.text_cab5e22222")); }
    if (!mapping(value)) throw new Error($t("lib.migration-redeem-state.text_cab5e22222"));
    return value;
  } finally {
    await file.close();
  }
}

export async function stageLegacyRedeemState(sourcePath: string, stagePath: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const [source, stage] = await Promise.all([realpath(sourcePath), realpath(stagePath)]);
  if (within(source, stage) || within(stage, source)) throw new Error($t("lib.migration-redeem-state.text_542cd9eac6"));

  const journal = { files: 0, entries: 0, pending: 0, duplicates: 0, conflicts: 0, authoritative: false };
  const activities = { files: 0, games: 0, entries: 0 };
  const entries = new Map<string, Entry>();
  const history = new Map<string, Set<string>>();
  const inventory = new Map<string, Stats | undefined>();

  for (const store of stores) {
    signal?.throwIfAborted();
    const root = join(source, store, "redeemCodes");
    const saved = await readFrozen(join(root, journalFile), journalMaxBytes, inventory);
    if (saved) {
      journal.files++;
      const marked = Object.hasOwn(saved, marker);
      if (marked && saved[marker] !== 1) throw new Error($t("lib.migration-redeem-state.text_565b79885f"));
      for (const [key, input] of Object.entries(saved)) {
        signal?.throwIfAborted();
        if (key === marker) continue;
        if (!batchKey.test(key)) throw new Error($t("lib.migration-redeem-state.text_08745cae18"));
        const entry = parseEntry(input);
        if (!marked) journal.authoritative = true;
        const prior = entries.get(key);
        if (prior) {
          journal.duplicates++;
          if (prior.time !== entry.time || prior.status !== entry.status) journal.conflicts++;
          // Both statuses block a duplicate. Keep evidence of any unconfirmed execution.
          if (prior.status === "started" && entry.status === "finished" ||
              prior.status === entry.status && prior.time >= entry.time) continue;
        }
        entries.set(key, entry);
      }
    }
    const cache = await readFrozen(join(root, activitiesFile), activitiesMaxBytes, inventory);
    if (!cache) continue;
    activities.files++;
    for (const { id } of REDEEM_GAMES) {
      const found = cache[id];
      if (!Array.isArray(found)) continue;
      const candidates = history.get(id) ?? new Set<string>();
      for (const value of found.filter(value => typeof value === "string" && activityId.test(value)).slice(0, historyLimit)) {
        if (candidates.size >= historyLimit) break;
        candidates.add(value);
      }
      if (candidates.size) history.set(id, candidates);
    }
  }

  journal.entries = entries.size;
  journal.pending = [...entries.values()].filter(entry => entry.status === "started").length;
  activities.games = history.size;
  activities.entries = [...history.values()].reduce((sum, list) => sum + list.size, 0);

  async function requireUnchanged() {
    for (const [path, expected] of inventory) {
      signal?.throwIfAborted();
      const actual = await optionalStat(path);
      if (expected ? !sameFile(expected, actual) || await realpath(path) !== path : actual !== undefined) throw changed();
    }
  }
  await requireUnchanged();

  if (!journal.files && !activities.files) return { journal, activities };
  const parent = join(stage, "data");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) throw new Error($t("lib.migration-redeem-state.text_18615c6173"));
  const directory = join(parent, "redeemCodes");
  await mkdir(directory, { mode: 0o700 });
  const created: string[] = [];
  async function write(name: string, value: unknown) {
    signal?.throwIfAborted();
    const path = join(directory, name);
    const file = await open(path, "wx", 0o600);
    created.push(path);
    try {
      await file.writeFile(JSON.stringify(value) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
  }
  try {
    if (journal.files) {
      const output = Object.fromEntries(entries);
      // An empty file, a discovery cache, or a new-install marker must not grant old accounts permission to submit.
      await write(journalFile, journal.authoritative ? output : { [marker]: 1, ...output });
    }
    if (activities.files) await write(activitiesFile, Object.fromEntries([...history].map(([game, ids]) => [game, [...ids]])));
    await requireUnchanged();
  } catch (error) {
    for (const path of created) await unlink(path);
    await rmdir(directory);
    throw error;
  }

  return { journal, activities };
}
