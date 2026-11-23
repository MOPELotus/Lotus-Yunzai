import type { Database } from "bun:sqlite";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createProfileStore, profileCookieAccountId, type Game } from "@lotus-yunzai/account";
import { writeJournal } from "./filesystem-transaction.ts";
import { gameProfileAccountFingerprint, gameProfileDefaultsPath } from "./game-profile-defaults.ts";
import { parseLegacyUserGames } from "./migration-public-role-references.ts";

const games = ["gs", "sr", "zzz"] as const;
const qqPattern = /^[1-9]\d{0,15}$/u;
const accountPattern = /^[1-9]\d{0,19}$/u;
const uidPattern = /^[1-9]\d{7,9}$/u;

function oldGameUid(value: unknown) {
  if (!value || typeof value !== "object" || !("uid" in value) || typeof value.uid !== "string" || !uidPattern.test(value.uid)) return;
  return value.uid;
}

async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
    throw new Error("暂存默认档案目录必须为实体目录。");
  }
}

/** 只有旧主 UID 和旧关联账号都能匹配唯一已迁移的本人登录档案时才接续。 */
export async function stageLegacyGameProfileDefaults(db: Database, stateDirectory: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const users = db.query<{ name: string; type: string }, []>("PRAGMA main.table_list('Users')").get();
  if (users?.name !== "Users" || users.type !== "table") return;
  const columns = new Set(db.query<{ name: string; hidden: number }, []>("PRAGMA main.table_xinfo('Users')").all()
    .filter(column => column.hidden === 0).map(({ name }) => name));
  if (!["id", "type", "games", "ltuids"].every(name => columns.has(name))) return;

  const result = { restored: 0, existing: 0 };
  const profiles = createProfileStore(join(stateDirectory, "data", "users"));
  const profileIds = new Map<string, number[]>();
  for (const { qq, profileId, loggedIn } of await profiles.listCheckinProfiles()) {
    signal?.throwIfAborted();
    if (!loggedIn) continue;
    const ids = profileIds.get(qq);
    if (ids) ids.push(profileId);
    else profileIds.set(qq, [profileId]);
  }
  const rows = db.query<{ id: unknown; ltuids: unknown; games: unknown }, []>(
    "SELECT id, ltuids, games FROM main.Users WHERE type COLLATE BINARY = 'qq' AND ltuids IS NOT NULL AND games IS NOT NULL ORDER BY id",
  );
  for (const { id: qq, ltuids, games: storedGames } of rows.iterate()) {
    signal?.throwIfAborted();
    if (typeof qq !== "string" || !qqPattern.test(qq) || !Number.isSafeInteger(Number(qq)) ||
        typeof ltuids !== "string" || ltuids.length > 8192) continue;
    const linked = new Set(ltuids.split(",").filter(id => accountPattern.test(id)));
    const decoded = parseLegacyUserGames(storedGames);
    if (!linked.size || !decoded) continue;
    const ids = profileIds.get(qq);
    if (!ids?.some(id => id > 1)) continue;

    const defaults: Partial<Record<Game, { profileId: number; account: string }>> = {};
    for (const game of games) {
      const selectedUid = oldGameUid(decoded[game]);
      if (!selectedUid) continue;
      const bindings = [];
      for (const id of ids) {
        signal?.throwIfAborted();
        const source = await profiles.requestSelectedContext(qq, id, game).catch(() => undefined);
        if (source?.role.uid !== selectedUid) continue;
        const account = profileCookieAccountId(source.account);
        if (account && linked.has(account)) bindings.push({ profileId: id, account: gameProfileAccountFingerprint(qq, game, account) });
      }
      if (bindings.length === 1 && bindings[0]!.profileId > 1) defaults[game] = bindings[0];
    }
    const count = Object.keys(defaults).length;
    if (!count) continue;

    let directory = stateDirectory;
    for (const part of [...gameProfileDefaultsPath.split("/"), qq]) {
      directory = join(directory, part);
      await privateDirectory(directory);
    }
    signal?.throwIfAborted();
    try {
      await writeJournal(join(directory, "1.json"), { version: 1, ...defaults }, true);
      result.restored += count;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      result.existing += count;
    }
  }
  return result.restored || result.existing ? result : undefined;
}
