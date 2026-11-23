import { Database } from "bun:sqlite";
import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readMigrationSourceFile } from "./migration-files.ts";
import { stageLegacyGameProfileDefaults } from "./migration-game-profile-defaults.ts";
import { stageLegacyPublicRoleReferences } from "./migration-public-role-references.ts";

const databaseName = "data.db";
const walName = "data.db-wal";
const shmName = "data.db-shm";
const journalName = "data.db-journal";
const family = [databaseName, walName, shmName, journalName] as const;
const preserved = [databaseName, walName, journalName] as const;
type PreservedName = typeof preserved[number];
const maximumFileBytes = 64 * 1024 * 1024;
class IncompleteSnapshot extends Error {}
const recapture = () => new IncompleteSnapshot("旧登录数据库快照不完整。");

async function optionalStat(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

function unchanged(first: Stats | undefined, second: Stats | undefined) {
  if (!first || !second) return first === second;
  return first.dev === second.dev && first.ino === second.ino && first.mode === second.mode &&
    first.nlink === second.nlink && first.size === second.size && first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs;
}

function databasePageSize(bytes: Buffer) {
  if (bytes.length < 100 || bytes.toString("latin1", 0, 16) !== "SQLite format 3\0") throw recapture();
  const storedSize = bytes.readUInt16BE(16);
  const size = storedSize === 1 ? 65_536 : storedSize;
  if (size < 512 || size > 65_536 || (size & (size - 1)) !== 0 || bytes.length % size !== 0) throw recapture();
  return size;
}

// SQLite stores these rolling checksum words big-endian, but the low magic bit selects
// the byte order in which to read the input words.
function verifyWal(bytes: Buffer, pageSize: number) {
  if (bytes.length < 32) throw recapture();
  const magic = bytes.readUInt32BE(0);
  const frameSize = pageSize + 24;
  if ((magic !== 0x377f0682 && magic !== 0x377f0683) || bytes.readUInt32BE(4) !== 3_007_000 ||
      bytes.readUInt32BE(8) !== pageSize || (bytes.length - 32) % frameSize !== 0) throw recapture();

  let first = 0;
  let second = 0;
  const word = (offset: number) => magic === 0x377f0682 ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  function updateChecksum(start: number, end: number) {
    for (let offset = start; offset < end; offset += 8) {
      first = (first + word(offset) + second) >>> 0;
      second = (second + word(offset + 4) + first) >>> 0;
    }
  }
  const matchesChecksum = (offset: number) => first === bytes.readUInt32BE(offset) && second === bytes.readUInt32BE(offset + 4);
  updateChecksum(0, 24);
  if (!matchesChecksum(24)) throw recapture();

  let committed = false;
  for (let offset = 32; offset < bytes.length; offset += frameSize) {
    if (!bytes.subarray(16, 24).equals(bytes.subarray(offset + 8, offset + 16))) {
      // A SQLite WAL reuse can leave frames of a previous generation after the current commit.
      if (committed) break;
      throw recapture();
    }
    if (bytes.readUInt32BE(offset) === 0) throw recapture();
    updateChecksum(offset, offset + 8);
    updateChecksum(offset + 24, offset + frameSize);
    if (!matchesChecksum(offset + 16)) throw recapture();
    committed ||= bytes.readUInt32BE(offset + 4) !== 0;
  }
}

async function writeDatabaseFiles(directory: string, main: Buffer, wal?: Buffer) {
  await writeFile(join(directory, databaseName), main, { mode: 0o600, flag: "wx" });
  if (wal) await writeFile(join(directory, walName), wal, { mode: 0o600, flag: "wx" });
}

async function validatePrivateCopy(stateDirectory: string, main: Buffer, wal?: Buffer, signal?: AbortSignal) {
  const directory = await mkdtemp(join(stateDirectory, ".legacy-sqlite-check-"));
  try {
    await writeDatabaseFiles(directory, main, wal);
    let database: Database;
    try { database = new Database(join(directory, databaseName), { readonly: true }); }
    catch { throw recapture(); }
    using db = database;
    try {
      const result = db.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").all();
      if (result.length !== 1 || result[0]?.quick_check !== "ok") throw recapture();
    } catch {
      throw recapture();
    }
    db.run("PRAGMA trusted_schema=OFF");
    db.run("PRAGMA query_only=ON");
    const publicRoleReferences = await stageLegacyPublicRoleReferences(db, stateDirectory, signal);
    const gameProfileDefaults = await stageLegacyGameProfileDefaults(db, stateDirectory, signal);
    return { ...(publicRoleReferences && { publicRoleReferences }), ...(gameProfileDefaults && { gameProfileDefaults }) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function sourceFamily(directory: string) {
  try {
    const parent = await optionalStat(directory);
    if (!parent) return null;
    if (!parent.isDirectory() || await realpath(directory) !== directory) return;
    const items = await Promise.all(family.map(name => optionalStat(join(directory, name))));
    return { parent, items };
  } catch {
    return;
  }
}

/** Archive a frozen copy without activating its credentials. An unusable old database does not prevent the supported data from migrating. */
export async function stageLegacyOfficialBindings(source: string, stateDirectory: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const absent = { type: "absent", files: 0 } as const;
  const unreadable = { type: "unreadable", files: 0 } as const;
  const sourceDirectory = join(source, "data", "db");
  const initial = await sourceFamily(sourceDirectory);
  if (initial === null || initial?.items.every(info => !info)) return absent;
  if (!initial) return unreadable;
  const [mainInfo, walInfo, shmInfo, rollbackInfo] = initial.items;
  let incomplete = !mainInfo || initial.items.some(info => info && (!info.isFile() || info.nlink !== 1)) ||
    ((shmInfo?.size ?? 0) > 0 && !walInfo?.size) || (rollbackInfo?.size ?? 0) > 0;
  const files = new Map<PreservedName, Buffer>();
  for (const name of preserved) {
    const info = initial.items[family.indexOf(name)];
    if (!info) continue;
    if (!info.isFile() || info.nlink !== 1 || info.size > maximumFileBytes) {
      incomplete = true;
      continue;
    }
    try {
      const file = await readMigrationSourceFile(source, join(sourceDirectory, name), maximumFileBytes, signal);
      if (file) files.set(name, file.bytes);
      else incomplete = true;
    } catch {
      signal?.throwIfAborted();
      incomplete = true;
    }
  }
  signal?.throwIfAborted();
  const current = await sourceFamily(sourceDirectory);
  if (!files.size || !current || !unchanged(initial.parent, current.parent) ||
      !initial.items.every((info, index) => unchanged(info, current.items[index]))) return unreadable;

  const main = files.get(databaseName);
  const savedWal = files.get(walName);
  const wal = savedWal?.length ? savedWal : undefined;
  let restored: Awaited<ReturnType<typeof validatePrivateCopy>> | undefined;
  if (!incomplete && main) {
    try {
      const pageSize = databasePageSize(main);
      if (wal) {
        if (main[18] !== 2 || main[19] !== 2) throw recapture();
        verifyWal(wal, pageSize);
      }
      restored = await validatePrivateCopy(stateDirectory, main, wal, signal);
    } catch (error) {
      if (!(error instanceof IncompleteSnapshot)) throw error;
      incomplete = true;
    }
  }
  signal?.throwIfAborted();

  const backup = join(stateDirectory, "backup", "legacy-official-bindings");
  await mkdir(backup, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of files) await writeFile(join(backup, name), bytes, { mode: 0o600, flag: "wx" });
  const type = incomplete ? "incomplete" : wal ? "sqlite-with-wal" : "sqlite";
  return { type, files: files.size, ...restored };
}
