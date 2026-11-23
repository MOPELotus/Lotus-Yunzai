import type { Database } from "bun:sqlite";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Game } from "@lotus-yunzai/account";
import { writeJournal } from "./filesystem-transaction.ts";
import {
  createPublicRoleReferenceTarget, publicRoleReferenceLimit, publicRoleReferencePath, type PublicRoleReferenceCatalogue,
} from "./public-role-references.ts";

const maximumGamesSize = 256 * 1024;
const qqPattern = /^[1-9]\d{0,15}$/u;
const uidPattern = /^[1-9]\d{7,9}$/u;

function dictionary(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
}

export function parseLegacyUserGames(input: unknown) {
  if (typeof input !== "string" || Buffer.byteLength(input) > maximumGamesSize) return;
  try { return dictionary(JSON.parse(input) as unknown); }
  catch { return; }
}

async function ensureDirectory(directory: string) {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) {
    throw new Error("暂存公开 UID 目录必须为实体目录。");
  }
}

export async function stageLegacyPublicRoleReferences(db: Database, stateDirectory: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const users = db.query<{ name: string; type: string }, []>("PRAGMA main.table_list('Users')").get();
  if (users?.name !== "Users" || users.type !== "table") return;
  const columns = new Set(db.query<{ name: string; hidden: number }, []>("PRAGMA main.table_xinfo('Users')").all()
    .filter(column => column.hidden === 0).map(({ name }) => name));
  if (!["id", "type", "games"].every(name => columns.has(name))) return;

  const references = { imported: 0, existing: 0, invalid: 0 };
  const publicTarget = createPublicRoleReferenceTarget();
  const rows = db.query<{ id: unknown; games: unknown }, []>(
    "SELECT Users.id, Users.games FROM main.Users WHERE Users.type COLLATE BINARY = 'qq' AND Users.games IS NOT NULL ORDER BY Users.id",
  );
  for (const { id, games: storedGames } of rows.iterate()) {
    signal?.throwIfAborted();
    const decoded = parseLegacyUserGames(storedGames);
    if (!decoded || typeof id !== "string" || !qqPattern.test(id) || !Number.isSafeInteger(Number(id))) {
      references.invalid++;
      continue;
    }
    const publicGame = async (game: Game) => {
      const old = dictionary(decoded[game]);
      const entries = dictionary(old?.data);
      if (!entries) return { uid: "", data: [] };
      const data: string[] = [];
      for (const [uid, item] of Object.entries(entries)) {
        signal?.throwIfAborted();
        const entry = dictionary(item);
        if (entry?.type !== "reg") continue;
        if (entry.uid !== uid || !uidPattern.test(uid) || data.length >= publicRoleReferenceLimit) {
          references.invalid++;
          continue;
        }
        try { await publicTarget(game, uid); }
        catch {
          references.invalid++;
          continue;
        }
        data.push(uid);
      }
      const selected = typeof old?.uid === "string" && data.includes(old.uid) ? old.uid : data[0] ?? "";
      return { uid: selected, data };
    };
    const saved: PublicRoleReferenceCatalogue = {
      gs: await publicGame("gs"), sr: await publicGame("sr"), zzz: await publicGame("zzz"),
    };
    if (!Object.values(saved).some(entry => entry.data.length)) continue;

    const directory = join(stateDirectory, publicRoleReferencePath);
    const user = join(directory, id);
    await ensureDirectory(join(stateDirectory, "data"));
    await ensureDirectory(directory);
    await ensureDirectory(user);
    signal?.throwIfAborted();
    try {
      await writeJournal(join(user, "1.json"), { version: 1, ...saved }, true);
      references.imported++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      references.existing++;
    }
  }
  signal?.throwIfAborted();
  return references;
}
