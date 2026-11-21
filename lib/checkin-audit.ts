import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MAX_PROFILE_ID } from "@lotus-yunzai/account";

const stages = {
  refresh: ["登录信息已刷新。", "签到前刷新登录信息失败。"],
  precheck: ["签到档案已核实。", "签到档案暂不可用。"],
  runner: ["签到任务已处理。", "签到任务执行失败。"],
  checkin: ["签到已完成。", "签到有未完成的项目。"],
  schedule: ["自动签到已处理。", "自动签到执行失败。"],
} as const;

const sources = ["manual", "scheduled", "scheduled_community_retry", "scheduled_retry"] as const;
const statuses = {
  signed: "签到成功", already: "已签到", "first-bind": "首次绑定",
  unconfirmed: "未确认", failed: "失败", skipped: "跳过",
  "community-accepted": "社区已受理", "community-already": "社区已签到",
} as const;
type Counts = Readonly<Partial<Record<keyof typeof statuses, number>>>;

export interface CheckinAuditEntry {
  readonly qq: string;
  readonly profileId: number;
  readonly ok: boolean;
  readonly stage: keyof typeof stages;
  readonly source: typeof sources[number];
  readonly counts?: Counts;
}

export interface CheckinAuditRow extends CheckinAuditEntry {
  readonly time: string;
  readonly message: string;
}

export type CheckinAuditScope = { readonly qq: string; readonly owner?: never } |
  { readonly owner: true; readonly qq?: never };

const limit = 12;
const readChunkBytes = 16 * 1024;
const maxLineBytes = 4 * 1024;
const qqDigits = /^[1-9]\d{0,18}$/u;
type Json = Record<string, unknown>;

function object(input: unknown): Json | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Json;
}

function validQq(value: unknown): value is string {
  return typeof value === "string" && qqDigits.test(value);
}

function validDate(time: unknown): time is string {
  if (typeof time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(time) ||
      !Number.isFinite(Date.parse(time))) return false;
  const civil = time.slice(0, 19);
  return new Date(`${civil}Z`).toISOString().slice(0, 19) === civil;
}

function normalizeCounts(input: unknown): Counts | undefined {
  const value = object(input);
  if (!value) return;
  const counts: Partial<Record<keyof typeof statuses, number>> = {};
  for (const key of Object.keys(statuses) as (keyof typeof statuses)[]) {
    if (!Object.hasOwn(value, key)) continue;
    const count = value[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return;
    counts[key] = count;
  }
  return counts;
}

function normalizeEntry(input: unknown): CheckinAuditEntry | undefined {
  const value = object(input);
  if (!value) return;
  const { qq, profileId, ok, stage, source } = value;
  if (!validQq(qq) || typeof profileId !== "number" || !Number.isInteger(profileId) ||
      profileId < 1 || profileId > MAX_PROFILE_ID || typeof ok !== "boolean" || typeof stage !== "string" ||
      !Object.hasOwn(stages, stage) || typeof source !== "string" || !sources.some((item) => item === source)) return;
  const counts = value.counts === undefined ? undefined : normalizeCounts(value.counts);
  if (value.counts !== undefined && counts === undefined) return;
  return { qq, profileId, ok, stage: stage as CheckinAuditEntry["stage"], source: source as CheckinAuditEntry["source"],
    ...(counts ? { counts } : {}) };
}

function rowFor(time: string, entry: CheckinAuditEntry): CheckinAuditRow {
  const names = (Object.keys(statuses) as (keyof typeof statuses)[]).flatMap((key) => {
    const count = entry.counts?.[key];
    return count ? [`${statuses[key]} ${count}`] : [];
  });
  const summary = stages[entry.stage][entry.ok ? 0 : 1];
  return { time, ...entry, message: names.length ? `${summary}${names.join("、")}。` : summary };
}

function decodeLine(input: Buffer, ownerQq: string | undefined): CheckinAuditRow | undefined {
  try {
    const data = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)));
    if (!data || (ownerQq !== undefined && data.qq !== ownerQq) || !validDate(data.time) || typeof data.message !== "string") return;
    const entry = normalizeEntry(data);
    if (entry) return rowFor(data.time, entry);
  } catch {
    // Old audit logs may contain malformed or interrupted lines.
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function directoryReady(directory: string, create: boolean): Promise<boolean> {
  let actual: string;
  try {
    actual = await realpath(directory);
  } catch (error) {
    if (!missing(error)) throw error;
    if (!create) return false;
    const parent = dirname(directory);
    if (parent === directory) throw error;
    await directoryReady(parent, true);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    });
    actual = await realpath(directory);
  }
  if (actual !== directory || !(await lstat(directory)).isDirectory()) throw new Error("签到审计目录必须是实际目录。");
  return true;
}

async function openAudit(file: string, append: boolean): Promise<FileHandle | undefined> {
  const directory = dirname(file);
  if (!await directoryReady(directory, append)) return;
  const access = append ? constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND : constants.O_RDONLY;
  const handle = await open(file, access | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600).catch((error: unknown) => {
    if (append || !missing(error)) throw error;
  });
  if (!handle) return;
  try {
    const [opened, named] = await Promise.all([handle.stat(), lstat(file)]);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino ||
        await realpath(directory) !== directory) throw new Error("签到审计目标必须是目录下的普通文件。");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function extendLine(prefix: Buffer, suffix: Buffer | undefined): Buffer | undefined {
  if (!suffix || prefix.length + suffix.length > maxLineBytes) return;
  return suffix.length ? Buffer.concat([prefix, suffix]) : prefix;
}

async function readRecent(handle: FileHandle, qq: string | undefined): Promise<readonly CheckinAuditRow[]> {
  const rows: CheckinAuditRow[] = [];
  const empty = Buffer.alloc(0);
  let suffix: Buffer | undefined = empty;
  let complete = false;
  let cursor = (await handle.stat()).size;

  function include(line: Buffer | undefined) {
    const row = line?.length ? decodeLine(line, qq) : undefined;
    if (row) rows.push(row);
  }

  while (cursor > 0 && rows.length < limit) {
    const start = Math.max(0, cursor - readChunkBytes);
    const block = Buffer.allocUnsafe(cursor - start);
    for (let offset = 0; offset < block.length;) {
      const { bytesRead } = await handle.read(block, offset, block.length - offset, start + offset);
      if (!bytesRead) throw new Error("签到审计文件在读取期间发生变化。");
      offset += bytesRead;
    }
    let end = block.length;
    while (end > 0 && rows.length < limit) {
      const newline = block.lastIndexOf(0x0a, end - 1);
      if (newline < 0) break;
      if (complete) include(extendLine(block.subarray(newline + 1, end), suffix));
      complete = true;
      suffix = empty;
      end = newline;
    }
    if (complete) suffix = extendLine(block.subarray(0, end), suffix);
    cursor = start;
  }
  if (complete && rows.length < limit) include(suffix);
  return rows;
}

export function createCheckinAudit(path: string, now = () => new Date(), history: readonly string[] = []) {
  if (typeof path !== "string" || !path.trim()) throw new TypeError("须指定签到审计文件。");
  const file = resolve(path);
  const sources = [...new Set([file, ...history.map(input => resolve(input))])];

  async function readFile(input: string, qq: string | undefined) {
    const handle = await openAudit(input, false);
    if (!handle) return [];
    try {
      return await readRecent(handle, qq);
    } finally {
      await handle.close();
    }
  }
  return {
    async append(input: CheckinAuditEntry): Promise<void> {
      const entry = normalizeEntry(input);
      const time = now();
      if (!entry || !Number.isFinite(time.getTime())) throw new TypeError("签到审计记录无效。");
      // One small O_APPEND write preserves record boundaries across writers.
      // A leading LF also separates any interrupted previous write.
      const buffer = Buffer.from(`\n${JSON.stringify(rowFor(time.toISOString(), entry))}\n`);
      const handle = (await openAudit(file, true))!;
      try {
        const { bytesWritten } = await handle.write(buffer, 0, buffer.length, null);
        if (bytesWritten !== buffer.length) throw new Error("签到审计记录未完整写入。");
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async read(scope: CheckinAuditScope): Promise<readonly CheckinAuditRow[]> {
      const qq = scope?.qq;
      if (!(validQq(qq) && scope.owner === undefined) && !(scope?.owner === true && qq === undefined)) {
        throw new TypeError("须指定签到审计所属 QQ 或明确请求全局记录。");
      }
      const batches = (await Promise.all(sources.map(input => readFile(input, qq)))).filter(batch => batch.length);
      if (batches.length <= 1) return batches[0] ?? [];
      const rows: CheckinAuditRow[] = [];
      const seen = new Set<string>();
      for (const batch of batches) {
        const thisFile = new Set<string>();
        for (const row of batch) {
          const key = JSON.stringify(row);
          if (!seen.has(key)) rows.push(row);
          thisFile.add(key);
        }
        for (const key of thisFile) seen.add(key);
      }
      return rows.sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, limit);
    },
  };
}
