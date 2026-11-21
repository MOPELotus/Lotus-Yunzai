import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readOptionalConfigFile } from "./config.ts";

const groupConfig = "config/config/group.yaml";
const scopes = [groupConfig, "data/srJson", "data/srJson.backup"] as const;
type StateScope = (typeof scopes)[number];

const accountDirectory = /^[1-9]\d{0,18}$/u;
const poolFile = /^(?:1|2|11|12|21|22)\.json$/u;
const maxFileBytes = 16 * 1024 * 1024;

interface SourceFile {
  readonly scope: StateScope;
  readonly path: string;
  readonly info: Stats;
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

function sourceChanged() {
  return new Error("迁移源在读取期间发生变化，请重新取得已停写的旧安装副本。");
}

function within(parent: string, path: string) {
  const local = relative(parent, path);
  return local !== ".." && !local.startsWith(".." + sep) && !isAbsolute(local);
}

async function sourceInventory(source: string) {
  const dirs = new Map<string, Stats>();
  const files: SourceFile[] = [];
  async function directory(path: string) {
    const info = await optionalStat(join(source, path));
    if (!info) return false;
    if (!info.isDirectory() || await realpath(join(source, path)) !== join(source, path)) {
      throw new Error("列入迁移的配置或逐抽路径须为实体目录。");
    }
    dirs.set(path, info);
    return true;
  }
  async function file(scope: StateScope, path: string) {
    const info = await optionalStat(join(source, path));
    if (!info) return;
    if (!info.isFile() || info.nlink !== 1) throw new Error("列入迁移的配置或逐抽文件须为无硬链接的普通文件。");
    if (info.size > maxFileBytes) throw new Error("列入迁移的配置或逐抽文件超过读取上限。");
    files.push({ scope, path, info });
  }

  if (!await directory("")) throw new Error("旧安装副本须为实体目录。");
  if (await directory("config") && await directory("config/config")) await file(groupConfig, groupConfig);
  if (await directory("data")) {
    for (const scope of ["data/srJson", "data/srJson.backup"] as const) {
      if (!await directory(scope)) continue;
      for (const qq of (await readdir(join(source, scope))).sort()) {
        if (!accountDirectory.test(qq) || !await directory(join(scope, qq))) continue;
        for (const uid of (await readdir(join(source, scope, qq))).sort()) {
          const account = join(scope, qq, uid);
          if (!accountDirectory.test(uid) || !await directory(account)) continue;
          for (const name of (await readdir(join(source, account))).sort()) {
            if (poolFile.test(name)) await file(scope, join(account, name));
          }
        }
      }
    }
  }
  return { files, dirs };
}

async function requireUnchanged(source: string, { files, dirs }: Awaited<ReturnType<typeof sourceInventory>>) {
  for (const [path, expected] of dirs) {
    const absolute = join(source, path);
    if (!sameFile(expected, await optionalStat(absolute)) || await realpath(absolute) !== absolute) throw sourceChanged();
  }
  for (const { path, info } of files) {
    if (!sameFile(info, await optionalStat(join(source, path)))) throw sourceChanged();
  }
}

function summarize(files: readonly SourceFile[]) {
  const counts = new Map<StateScope, { files: number; bytes: number }>();
  for (const { scope, info } of files) {
    const item = counts.get(scope) ?? { files: 0, bytes: 0 };
    item.files++;
    item.bytes += info.size;
    counts.set(scope, item);
  }
  return scopes.map(path => ({ path, ...(counts.get(path) ?? { files: 0, bytes: 0 }) }));
}

export async function planLegacyState(sourcePath: string) {
  const source = await realpath(sourcePath);
  const inventory = await sourceInventory(source);
  await requireUnchanged(source, inventory);
  return summarize(inventory.files);
}

async function readSource(source: string, { path, info }: SourceFile) {
  const absolute = join(source, path);
  if (await realpath(absolute) !== absolute) throw sourceChanged();
  const opened = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const first = await opened.stat();
    if (!first.isFile() || first.nlink !== 1 || !sameFile(info, first)) throw sourceChanged();
    const bytes = Buffer.alloc(first.size);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await opened.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw sourceChanged();
      offset += bytesRead;
    }
    if (!sameFile(first, await opened.stat()) || await realpath(absolute) !== absolute) throw sourceChanged();
    return bytes;
  } finally {
    await opened.close();
  }
}

function checkPool(bytes: Uint8Array) {
  try {
    if (Array.isArray(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))) return;
  } catch {}
  throw new Error("星铁旧逐抽卡池须为有效的 UTF-8 JSON 数组。");
}

/** Creates a fresh private overlay. The caller alone decides how to adopt it. */
export async function stageLegacyState(sourcePath: string, stagingParent: string, signal?: AbortSignal) {
  const [source, parent] = await Promise.all([realpath(sourcePath), realpath(stagingParent)]);
  if (within(source, parent) || !(await lstat(parent)).isDirectory()) {
    throw new Error("迁移暂存须位于旧安装副本之外的实体目录。");
  }
  const inventory = await sourceInventory(source);
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(parent, "legacy-state-"));
  try {
    for (const item of inventory.files) {
      signal?.throwIfAborted();
      const bytes = await readSource(source, item);
      if (item.scope !== groupConfig) checkPool(bytes);
      const destination = join(directory, item.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    }
    if (inventory.files.some(item => item.scope === groupConfig)) {
      await readOptionalConfigFile(pathToFileURL(directory + sep), groupConfig);
    }
    await requireUnchanged(source, inventory);
    signal?.throwIfAborted();
    return { directory, plan: summarize(inventory.files) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
