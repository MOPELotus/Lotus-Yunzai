import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lockFile } from "./file-lock.ts";

interface Activation {
  readonly id: string;
  readonly candidate: string;
  readonly state: readonly string[];
  readonly committed: boolean;
}

const persistentDirectories = ["config", "data", "logs", "internal"];
const dotenvPaths = [".env", ".env.local", ".env.production", ".env.development", ".env.test"];
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

function filesystemCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (filesystemCode(error) === "ENOENT") return false;
    throw error;
  }
}

function within(parent: string, path: string): boolean {
  const part = relative(parent, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

function statePaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)].sort();
  for (const [index, path] of unique.entries()) {
    if (typeof path !== "string" || /[\\\u0000-\u001f]/u.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part === "node_modules") ||
        path === "panel" || path === "panel/dist" || path.startsWith("panel/dist/") ||
        unique.slice(0, index).some((parent) => path.startsWith(`${parent}/`))) {
      throw new Error("持久状态路径无效或重叠。");
    }
  }
  return unique;
}

async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function move(source: string, destination: string) {
  if (await exists(destination)) throw new Error("版本切换目标已存在。");
  await rename(source, destination);
  const parent = dirname(source);
  await syncDirectory(parent);
  if (dirname(destination) !== parent) await syncDirectory(dirname(destination));
}

function journalPath(root: string) {
  return join(dirname(root), `.${basename(root)}.lotus-update.json`);
}

function backupPath(root: string, id: string) {
  return join(dirname(root), `.${basename(root)}.lotus-previous-${id}`);
}

async function writeJournal(path: string, entry: Activation, exclusive: boolean) {
  const temporary = `${path}.${crypto.randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(entry));
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeJournal(path: string) {
  await rm(path);
  await syncDirectory(dirname(path));
}

async function checkedParents(root: string, path: string, create: boolean) {
  let current = root;
  for (const part of path.split("/").slice(0, -1)) {
    const parent = current;
    current = join(parent, part);
    if (!await exists(current)) {
      if (!create) return;
      await mkdir(current);
      await syncDirectory(parent);
    }
    if (!(await lstat(current)).isDirectory()) throw new Error("持久状态路径经过非实体目录。");
  }
}

async function rollback(root: string, entry: Activation) {
  const backup = backupPath(root, entry.id);
  if (!await exists(backup)) return;
  if (await exists(root)) {
    if (await exists(entry.candidate)) throw new Error("无法确认需要回退的版本目录。");
    const stagingExists = await exists(dirname(entry.candidate));
    const destination = stagingExists ? await canonicalLocation(entry.candidate)
      : join(dirname(root), `.${basename(root)}.lotus-failed-${entry.id}`);
    if (stagingExists && destination !== entry.candidate) throw new Error("候选暂存位置已变更。");
    for (const path of entry.state) {
      const previousState = join(backup, path);
      const activeState = join(root, path);
      await checkedParents(backup, path, false);
      await checkedParents(root, path, false);
      if (!await exists(previousState) && await exists(activeState)) {
        await checkedParents(backup, path, true);
        await move(activeState, previousState);
      }
    }
    await move(root, destination);
  }
  await move(backup, root);
}

async function canonicalLocation(path: string) {
  const absolute = resolve(path);
  return join(await realpath(dirname(absolute)), basename(absolute));
}

export async function activateUpdate(
  active: string,
  candidate: string,
  verify: (directory: string) => Promise<void>,
  additionalStatePaths: readonly string[] = [],
  validate?: () => Promise<void>,
): Promise<{ previous: string }> {
  const root = await canonicalLocation(active);
  const next = await canonicalLocation(candidate);
  const path = journalPath(root);
  const lock = await lockFile(`${path}.sqlite`, "版本切换", 0);
  try {
    await validate?.();
    return await switchVersion(root, next, verify, additionalStatePaths, path);
  } finally {
    lock.close();
  }
}

async function switchVersion(
  root: string, next: string, verify: (directory: string) => Promise<void>, additionalStatePaths: readonly string[], path: string,
): Promise<{ previous: string }> {
  const [currentInfo, nextInfo] = await Promise.all([lstat(root), lstat(next)]);
  if (!currentInfo.isDirectory() || !nextInfo.isDirectory() || currentInfo.dev !== nextInfo.dev ||
      within(root, next) || within(next, root)) throw new Error("候选和活动宿主须为同文件系统的独立目录。");

  const protectedPaths = statePaths([...persistentDirectories, ...dotenvPaths, ...additionalStatePaths,
    ...(await readdir(root)).filter((name) => name === ".env" || name.startsWith(".env."))]);
  const state: string[] = [];
  for (const name of protectedPaths) {
    await checkedParents(root, name, false);
    await checkedParents(next, name, false);
    if (await exists(join(next, name))) throw new Error("候选目录占用了持久状态路径。");
    if (await exists(join(root, name))) state.push(name);
  }
  const entry: Activation = { id: crypto.randomUUID(), candidate: next, state, committed: false };
  const previous = backupPath(root, entry.id);

  // The caller has already stopped the old process. A probe must reap its child before returning.
  await writeJournal(path, entry, true);
  try {
    await move(root, previous);
    await move(next, root);
    for (const name of state) {
      const source = join(previous, name);
      if (!await exists(source)) continue;
      await checkedParents(root, name, true);
      await move(source, join(root, name));
    }
    await verify(root);
  } catch (error) {
    await rollback(root, entry);
    await removeJournal(path);
    throw error;
  }

  await writeJournal(path, { ...entry, committed: true }, false);
  await removeJournal(path);
  return { previous };
}

export async function recoverUpdateActivation(active: string): Promise<boolean> {
  const root = await canonicalLocation(active);
  const path = journalPath(root);
  const lock = await lockFile(`${path}.sqlite`, "版本切换", 0);
  try {
    return await recover(root, path);
  } finally {
    lock.close();
  }
}

async function recover(root: string, path: string): Promise<boolean> {
  if (!await exists(path)) return false;
  const info = await lstat(path);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error("版本切换记录无效。");
  const entry = await Bun.file(path).json() as Activation;
  if (!entry || typeof entry.id !== "string" || !idPattern.test(entry.id) ||
      typeof entry.candidate !== "string" || !isAbsolute(entry.candidate) || typeof entry.committed !== "boolean" ||
      !Array.isArray(entry.state) || !entry.state.every((name) => typeof name === "string") ||
      resolve(entry.candidate) !== entry.candidate ||
      within(root, entry.candidate) || within(entry.candidate, root)) throw new Error("版本切换记录无效。");
  statePaths(entry.state);
  if (!entry.committed) await rollback(root, entry);
  await removeJournal(path);
  return true;
}
