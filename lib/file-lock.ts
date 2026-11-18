import { Database } from "bun:sqlite";
import { lstat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function lockFile(file: string, subject: string, waitMs = 2_000): Promise<Database> {
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
        if (performance.now() >= deadline) throw new Error(`${subject}正在更新，请稍后重试。`);
        await delay(20);
      }
    }
  } catch (error) {
    database.close();
    throw error;
  }
}
