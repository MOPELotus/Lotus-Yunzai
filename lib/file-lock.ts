import { Database } from "bun:sqlite";
import { lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function managedHostLockPath(root: string): string {
  return join(dirname(root), `.${basename(root)}.lotus-host.sqlite`);
}

export async function lockFile(file: string, subject: string, waitMs = 2_000, busy = `${subject}正在更新，请稍后重试。`): Promise<Database> {
  try {
    if (!(await lstat(file)).isFile()) throw new Error(`${subject}锁须为普通文件。`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }

  // The sidecar path stays stable and SQLite releases the OS lock on process exit.
  const database = new Database(file);
  const deadline = performance.now() + waitMs;
  try {
    database.exec("PRAGMA busy_timeout = 0");
    for (;;) {
      try {
        database.exec("BEGIN IMMEDIATE");
        return database;
      } catch (error) {
        if (!(error as NodeJS.ErrnoException | undefined)?.code?.startsWith("SQLITE_BUSY")) throw error;
        if (performance.now() >= deadline) throw new Error(busy);
        await delay(20);
      }
    }
  } catch (error) {
    database.close();
    throw error;
  }
}
