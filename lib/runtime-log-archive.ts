import { randomUUID } from "node:crypto";
import { constants, createWriteStream, type Stats } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const dailyLog = /^command\.(\d{4}-\d{2}-\d{2})\.log(?:\.gz)?$/u;
const retainedArchives = 180;

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function unchanged(before: Stats, after: Stats) {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function sync(file: string, flags: number) {
  const handle = await open(file, flags | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function archive(source: string, signal?: AbortSignal) {
  const destination = source + ".gz";
  try {
    await lstat(destination);
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }

  const temporary = `${source}.${randomUUID()}.tmp`;
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await input.stat();
    if (!before.isFile()) return;
    await pipeline(input.createReadStream({ autoClose: false }), createGzip(),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal });
    await sync(temporary, constants.O_RDONLY);
    signal?.throwIfAborted();
    if (!unchanged(before, await lstat(source))) return;
    // Publish only a complete archive and preserve any existing archive for this day.
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") return;
      throw error;
    }
    await sync(dirname(source), constants.O_RDONLY | constants.O_DIRECTORY);
    if (unchanged(before, await lstat(source))) await unlink(source);
  } finally {
    try {
      await input.close();
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }
}

export async function archiveRuntimeLogs(directory: string, currentFilename: string, signal?: AbortSignal) {
  const currentDate = dailyLog.exec(currentFilename)?.[1];
  if (!currentDate || !currentFilename.endsWith(".log")) return;
  signal?.throwIfAborted();
  if (await realpath(directory) !== directory) throw new Error("日志目录已变更。");
  const previous: string[] = [];
  const archived: string[] = [];
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const date = dailyLog.exec(file.name)?.[1];
    if (!file.isFile() || !date || date >= currentDate) continue;
    const parsed = Date.parse(date);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) continue;
    (file.name.endsWith(".gz") ? archived : previous).push(file.name);
  }
  // Like a daily appender, close the most recent previous file on the next active day.
  const previousDay = previous.sort().at(-1);
  if (previousDay && !archived.includes(`${previousDay}.gz`)) {
    const source = join(directory, previousDay);
    await archive(source, signal);
    const completed = await lstat(source + ".gz").catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
    if (completed?.isFile()) archived.push(`${previousDay}.gz`);
  }
  const expired = archived.sort().reverse().slice(retainedArchives);
  for (const filename of expired) {
    signal?.throwIfAborted();
    await unlink(join(directory, filename)).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
}
