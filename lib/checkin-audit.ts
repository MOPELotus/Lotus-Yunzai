import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MAX_PROFILE_ID } from "@lotus-yunzai/account";

const stages = {
  refresh: [$t("lib.checkin-audit.text_4d916d13ab"), $t("lib.checkin-audit.text_eb4a8584fb")],
  precheck: [$t("lib.checkin-audit.text_f70dc44dfc"), $t("lib.checkin-audit.text_1b24d2f578")],
  runner: [$t("lib.checkin-audit.text_2902ff51b1"), $t("lib.checkin-audit.text_f7297452f8")],
  checkin: [$t("lib.checkin-audit.text_019bcedd50"), $t("lib.checkin-audit.text_0b59f950f2")],
  schedule: [$t("lib.checkin-audit.text_5bc17638e0"), $t("lib.checkin-audit.text_26ed6ad5da")],
} as const;

const sources = ["manual", "scheduled", "scheduled_community_retry", "scheduled_retry"] as const;
const statuses = {
  signed: $t("lib.checkin-audit.text_ac1ea22ab4"), already: $t("lib.checkin-audit.text_21c05833ab"), "first-bind": $t("lib.checkin-audit.text_08fcbb5ef4"),
  unconfirmed: $t("lib.checkin-audit.text_c098e854e6"), failed: $t("lib.checkin-audit.text_28384d7afd"), skipped: $t("lib.checkin-audit.text_fc50a99caa"),
  "community-accepted": $t("lib.checkin-audit.text_f8634db887"), "community-already": $t("lib.checkin-audit.text_8ee650a394"),
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

export function isStoredCheckinAuditTime(time: unknown): time is string {
  if (typeof time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(time) ||
      !Number.isFinite(Date.parse(time))) return false;
  const civil = time.slice(0, 19);
  const calendar = new Date(`${civil}Z`);
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 19) === civil;
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

export function storedCheckinAuditSource(source: unknown): CheckinAuditEntry["source"] | undefined {
  if (source === "scheduled_signin_retry") return "scheduled_retry";
  if (source === "manual_community_retry") return "manual";
  return sources.find(value => value === source);
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
    if (!data || (ownerQq !== undefined && data.qq !== ownerQq) || !isStoredCheckinAuditTime(data.time) || typeof data.message !== "string") return;
    const entry = normalizeEntry({ ...data, source: storedCheckinAuditSource(data.source) });
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
  if (actual !== directory || !(await lstat(directory)).isDirectory()) throw new Error($t("lib.checkin-audit.text_14408eca2e"));
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
        await realpath(directory) !== directory) throw new Error($t("lib.checkin-audit.text_f676a387a9"));
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function appendPrivateAuditLine(path: string, row: object): Promise<void> {
  // One O_APPEND write preserves record boundaries. A leading LF separates an interrupted write.
  const buffer = Buffer.from(`\n${JSON.stringify(row)}\n`);
  const handle = (await openAudit(resolve(path), true))!;
  try {
    const { bytesWritten } = await handle.write(buffer, 0, buffer.length, null);
    if (bytesWritten !== buffer.length) throw new Error($t("lib.checkin-audit.text_8c45f8b7b0"));
    await handle.sync();
  } finally {
    await handle.close();
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
      if (!bytesRead) throw new Error($t("lib.checkin-audit.text_adb49ddc91"));
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
  if (typeof path !== "string" || !path.trim()) throw new TypeError($t("lib.checkin-audit.text_07324407a5"));
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
      if (!entry || !Number.isFinite(time.getTime())) throw new TypeError($t("lib.checkin-audit.text_372bffee58"));
      await appendPrivateAuditLine(file, rowFor(time.toISOString(), entry));
    },
    async read(scope: CheckinAuditScope): Promise<readonly CheckinAuditRow[]> {
      const qq = scope?.qq;
      if (!(validQq(qq) && scope.owner === undefined) && !(scope?.owner === true && qq === undefined)) {
        throw new TypeError($t("lib.checkin-audit.text_4080da0ca9"));
      }
      const batches = (await Promise.all(sources.map(input => readFile(input, qq)))).filter(batch => batch.length);
      if (batches.length <= 1) return batches[0] ?? [];
      const rows: CheckinAuditRow[] = [];
      const seen = new Map<string, number>();
      for (const batch of batches) {
        const thisFile = new Map<string, number>();
        for (const row of batch) {
          // Copies can use different offsets for one instant. Keep genuine repeat rows within each file.
          const key = JSON.stringify({ ...row, time: Date.parse(row.time) });
          const occurrences = (thisFile.get(key) ?? 0) + 1;
          if (occurrences > (seen.get(key) ?? 0)) rows.push(row);
          thisFile.set(key, occurrences);
        }
        for (const [key, occurrences] of thisFile) seen.set(key, Math.max(occurrences, seen.get(key) ?? 0));
      }
      return rows.sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, limit);
    },
  };
}
