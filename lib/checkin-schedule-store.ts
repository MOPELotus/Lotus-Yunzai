import { Database } from "bun:sqlite";
import { constants, linkSync, unlinkSync, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isCheckinScheduleDate, legacyUnconfirmedStage, parseCheckinSchedulePlan,
  type CheckinScheduleEntry, type CheckinSchedulePlan } from "./checkin-schedule-plan.ts";
import { lockFile } from "./file-lock.ts";

interface ScheduleUpdate<T> {
  readonly plan?: CheckinSchedulePlan;
  readonly result: T;
}

const maxPlanBytes = 4 * 1024 * 1024;
const safeRead = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function named(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: unknown) => {
    if (errno(error) !== "ENOENT") throw error;
    return undefined;
  });
}

function sameInode(a: Stats, b: Stats | undefined): boolean {
  return b?.dev === a.dev && b.ino === a.ino;
}

function stableFile(a: Stats, b: Stats): boolean {
  return sameInode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
}

async function scheduleDirectory(path: string, create: boolean): Promise<Stats | undefined> {
  let info = await named(path);
  if (!info) {
    const parent = dirname(path);
    if (parent === path) throw new Error("无法读取自动签到计划目录。");
    await scheduleDirectory(parent, create);
    if (!create) return;
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if (errno(error) !== "EEXIST") throw error;
    });
    info = await named(path);
  }
  if (!info?.isDirectory() || await realpath(path) !== path) {
    throw new Error("自动签到计划目录须为实际目录。");
  }
  return info;
}

async function assertDirectory(path: string, expected: Stats) {
  const current = await scheduleDirectory(path, false);
  if (!sameInode(expected, current)) throw new Error("自动签到计划目录已变更。");
}

function projected(value: unknown, date: string): CheckinSchedulePlan {
  const plan = parseCheckinSchedulePlan(value);
  if (plan.date !== date) throw new Error("自动签到计划日期与文件不一致。");
  return plan;
}

function decoded(bytes: Uint8Array, date: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("自动签到计划 JSON 无效。");
  }
  const plan = projected(raw, date);
  const imported = (raw as { importedLegacy?: unknown }).importedLegacy;
  if (imported !== undefined && (!Array.isArray(imported) || !imported.every(id => typeof id === "string"))) {
    throw new Error("签到计划迁移记录无效。");
  }
  return { plan, imported: (imported ?? []) as string[] };
}

function progress(entry: CheckinScheduleEntry) {
  if (entry.stage === legacyUnconfirmedStage) return 2;
  if (entry.done) return 3;
  if (entry.runningAt) return 2;
  return entry.communityWrites || entry.communityRetry ? 1 : 0;
}

function mergePlan(current: CheckinSchedulePlan | undefined, source: CheckinSchedulePlan): CheckinSchedulePlan {
  const key = (item: CheckinScheduleEntry) => `${item.qq}/${item.profileId}`;
  const entries = new Map(current?.entries.map(item => [key(item), item]));
  for (const original of source.entries) {
    const previous = entries.get(key(original));
    let historical = original;
    if (original.runningAt && !original.done) {
      const { ok: _ok, ...pending } = original;
      historical = { ...pending, done: true, stage: legacyUnconfirmedStage, message: "旧版签到结果待核对。" };
    }
    if (!previous || isDeepStrictEqual(previous, original)) {
      entries.set(key(original), historical);
      continue;
    }
    const priorProgress = progress(previous), historicalProgress = progress(historical);
    if (priorProgress > 0 && priorProgress < 3 && priorProgress === historicalProgress && !isDeepStrictEqual(previous, historical)) {
      throw new Error("签到计划中同一档案有冲突的历史执行记录。");
    }
    const chosen = historicalProgress > priorProgress ? historical : previous;
    const noticeAttemptedAt = chosen.noticeAttemptedAt ?? previous.noticeAttemptedAt ?? historical.noticeAttemptedAt;
    entries.set(key(original), { ...chosen, notified: previous.notified || historical.notified,
      ...(noticeAttemptedAt && { noticeAttemptedAt }) });
  }
  return projected({ ...(current ?? source), entries: [...entries.values()] }, source.date);
}

async function isInterruptedLink(info: Stats, otherPath: string): Promise<boolean> {
  if (info.nlink !== 2) return false;
  const other = await named(otherPath);
  return other?.isFile() === true && sameInode(info, other);
}

class CheckinScheduleReadConflict extends Error {
  constructor() { super("自动签到计划在读取期间已变更。"); }
}

async function snapshot(file: string, stage: string) {
  const handle = await open(file, safeRead).catch((error: unknown) => {
    if (errno(error) === "ENOENT") return undefined;
    throw new Error("无法安全读取自动签到计划文件。");
  });
  if (!handle) return;
  try {
    const state = await handle.stat();
    const visible = await named(file);
    if (!state.isFile() || state.size > maxPlanBytes || (visible && !visible.isFile())) {
      throw new Error("自动签到计划须为同一目录下的普通文件。");
    }
    if (!sameInode(state, visible)) throw new CheckinScheduleReadConflict();
    if (state.nlink !== 1 && !await isInterruptedLink(state, stage)) throw new Error("自动签到计划须为同一目录下的普通文件。");
    const bytes = Buffer.allocUnsafe(state.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new CheckinScheduleReadConflict();
      offset += bytesRead;
    }
    if (!stableFile(state, await handle.stat()) || !sameInode(state, await named(file))) {
      throw new CheckinScheduleReadConflict();
    }
    return { bytes, state };
  } finally {
    await handle.close();
  }
}

async function checkLock(lock: string) {
  for (const path of [lock, `${lock}-journal`, `${lock}-wal`, `${lock}-shm`]) {
    const info = await named(path);
    if (info && (!info.isFile() || info.nlink !== 1)) throw new Error("自动签到计划锁须为单链接普通文件。");
  }
}

async function clearStage(stage: string, file: string) {
  const info = await named(stage);
  if (!info) return;
  if (!info.isFile() || (info.nlink !== 1 && !await isInterruptedLink(info, file))) {
    throw new Error("自动签到计划的临时文件不安全。");
  }
  await unlink(stage);
}

async function verifySnapshot(file: string, stage: string, previous: Awaited<ReturnType<typeof snapshot>>) {
  const current = await snapshot(file, stage);
  if (previous
    ? !current || !stableFile(previous.state, current.state) || !previous.bytes.equals(current.bytes)
    : current !== undefined) {
    throw new Error("自动签到计划已被其他进程修改，请重试。");
  }
}

export function createCheckinScheduleStore(path: string, legacy: readonly { id: string; directory: string }[] = []) {
  if (typeof path !== "string" || !path.trim()) throw new TypeError("须指定自动签到计划目录。");
  const directory = resolve(path);

  function files(date: string, base = directory) {
    if (!isCheckinScheduleDate(date)) throw new TypeError("自动签到计划日期无效。");
    return {
      file: join(base, `${date}.json`),
      stage: join(base, `.${date}.lotus-checkin.tmp`),
      lock: join(base, `.${date}.lotus-checkin.sqlite`),
      executionLock: join(base, `.${date}.lotus-checkin.run.sqlite`),
    };
  }

  async function readDirectory(date: string, base: string) {
    const { file, stage } = files(date, base);
    const initial = await scheduleDirectory(base, false);
    if (!initial) return;
    const current = await snapshot(file, stage).catch(async (error: unknown) => {
      if (!(error instanceof CheckinScheduleReadConflict)) throw error;
      await assertDirectory(base, initial);
      return snapshot(file, stage);
    });
    await assertDirectory(base, initial);
    return current && decoded(current.bytes, date);
  }

  async function withLegacy(date: string, current?: ReturnType<typeof decoded>) {
    let plan = current?.plan;
    const imported = new Set(current?.imported);
    for (const source of legacy) {
      if (imported.has(source.id)) continue;
      const history = await readDirectory(date, resolve(source.directory));
      if (!history) continue;
      plan = mergePlan(plan, history.plan);
      imported.add(source.id);
    }
    return { plan, imported: [...imported] };
  }

  async function read(date: string): Promise<CheckinSchedulePlan | undefined> {
    return (await withLegacy(date, await readDirectory(date, directory))).plan;
  }

  async function update<T>(date: string, change: (current: CheckinSchedulePlan | undefined) => ScheduleUpdate<T> | Promise<ScheduleUpdate<T>>): Promise<T> {
    const { file, stage, lock } = files(date);
    const initial = (await scheduleDirectory(directory, true))!;
    const anchor = await open(directory, safeRead | constants.O_DIRECTORY);
    try {
      if (!sameInode(initial, await anchor.stat())) throw new Error("自动签到计划目录已变更。");
      await checkLock(lock);
      const database = await lockFile(lock, "自动签到计划");
      try {
        await assertDirectory(directory, initial);
        await checkLock(lock);
        await clearStage(stage, file);
        const previous = await snapshot(file, stage);
        const current = previous && decoded(previous.bytes, date);
        const effective = await withLegacy(date, current);
        const { plan, result } = await change(effective.plan);
        const next = plan === undefined ? undefined : projected(plan, date);
        if (next === undefined || (isDeepStrictEqual(next, current?.plan) && effective.imported.length === current?.imported.length)) {
          await assertDirectory(directory, initial);
          await verifySnapshot(file, stage, previous);
          return result;
        }
        const stored = effective.imported.length ? { ...next, importedLegacy: effective.imported } : next;
        const bytes = Buffer.from(`${JSON.stringify(stored, null, 2)}\n`);
        if (bytes.length > maxPlanBytes) throw new Error("自动签到计划超过大小上限。");
        // Check the exact serialization before publication, including the date.
        decoded(bytes, date);
        await assertDirectory(directory, initial);
        const output = await open(stage, "wx", 0o600);
        try {
          const staged = await output.stat();
          await output.writeFile(bytes);
          await output.sync();
          await assertDirectory(directory, initial);
          await verifySnapshot(file, stage, previous);
          if (!sameInode(staged, await named(stage))) throw new Error("自动签到计划临时文件已变更。");
          if (previous) {
            await rename(stage, file);
          } else {
            linkSync(stage, file);
            unlinkSync(stage);
          }
          await anchor.sync();
        } finally {
          const staged = await output.stat();
          await output.close();
          if (sameInode(staged, await named(stage))) await unlink(stage);
        }
        return result;
      } finally {
        database.close();
      }
    } finally {
      await anchor.close();
    }
  }

  async function withExecutionLock<T>(date: string, run: () => T | Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }> {
    const { executionLock } = files(date);
    const initial = (await scheduleDirectory(directory, true))!;
    await checkLock(executionLock);
    let database: Database | undefined;
    try {
      try {
        database = new Database(executionLock);
        database.exec("PRAGMA busy_timeout = 0");
        database.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (errno(error)?.startsWith("SQLITE_BUSY")) return { acquired: false };
        throw error;
      }
      await assertDirectory(directory, initial);
      await checkLock(executionLock);
      return { acquired: true, value: await run() };
    } finally {
      database?.close();
    }
  }

  return { read, update, withExecutionLock };
}
