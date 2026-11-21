import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lockFile, managedHostLockPath, managedStartupLockPath } from "./file-lock.ts";
import { exists, move, removeJournal, syncDirectory, writeJournal } from "./filesystem-transaction.ts";
import { createLocalGit } from "./local-git.ts";
import { recoverUpdateActivation } from "./update-activation.ts";

const scopes = ["config", "data", "backup"] as const;
const journalLimit = 64 * 1024;

type Scope = (typeof scopes)[number];
interface PhysicalDirectory {
  readonly dev: number;
  readonly ino: number;
}
interface PublicationEntry {
  readonly version: 1;
  readonly target: PhysicalDirectory;
  readonly stage: PhysicalDirectory & { readonly path: string };
  readonly state: readonly (PhysicalDirectory & { readonly path: Scope })[];
  readonly committed: boolean;
}

function pathFor(target: string, kind: "pending" | "applied") {
  return join(dirname(target), `.${basename(target)}.lotus-migration-${kind}.json`);
}

function within(parent: string, path: string) {
  const local = relative(parent, path);
  return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}

function isScope(path: string): path is Scope {
  return scopes.some(scope => scope === path);
}

function identity(info: Stats): PhysicalDirectory {
  if (!info.isDirectory()) throw new Error("迁移发布路径须为实体目录。");
  return { dev: info.dev, ino: info.ino };
}

function matches(info: Stats, expected: PhysicalDirectory) {
  return info.isDirectory() && info.dev === expected.dev && info.ino === expected.ino;
}

function recordedPhysical(value: unknown): value is PhysicalDirectory {
  if (!value || typeof value !== "object") return false;
  const physical = value as Partial<PhysicalDirectory>;
  return Number.isSafeInteger(physical.dev) && Number.isSafeInteger(physical.ino) &&
    physical.dev! >= 0 && physical.ino! > 0;
}

async function readEntry(path: string, root: string) {
  if (!await exists(path)) return;
  const input = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await input.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > journalLimit) throw new Error("迁移发布记录无效。");
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await input.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error("迁移发布记录无效。");
    const entry = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as PublicationEntry;
    if (!entry || entry.version !== 1 || typeof entry.committed !== "boolean" || !recordedPhysical(entry.target) ||
        !recordedPhysical(entry.stage) || typeof entry.stage.path !== "string" || !isAbsolute(entry.stage.path) ||
        resolve(entry.stage.path) !== entry.stage.path || within(root, entry.stage.path) || within(entry.stage.path, root) ||
        entry.stage.dev !== entry.target.dev || !Array.isArray(entry.state) ||
        !entry.state.length || entry.state.length > scopes.length || !entry.state.every((item: unknown) =>
          recordedPhysical(item) && "path" in item && typeof item.path === "string" && isScope(item.path) && item.dev === entry.target.dev) ||
        new Set(entry.state.map(item => item.path)).size !== entry.state.length) throw new Error("迁移发布记录无效。");
    return entry;
  } finally {
    await input.close();
  }
}

async function syncPayload(path: string, device: number) {
  const expected = await lstat(path);
  if (expected.dev !== device) throw new Error("迁移目录跨文件系统。");
  if (expected.isSymbolicLink()) return;
  if (expected.isDirectory()) {
    for (const name of await readdir(path)) await syncPayload(join(path, name), device);
    await syncDirectory(path);
    return;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) {
      throw new Error("迁移暂存目录包含特殊文件，或文件在发布期间发生变化。");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publicationLocations(root: string, entry: PublicationEntry) {
  if (!matches(await lstat(root), entry.target) || !matches(await lstat(entry.stage.path), entry.stage) ||
      await realpath(entry.stage.path) !== entry.stage.path) throw new Error("目标或暂存目录已变更，无法恢复迁移发布。");
  const result: { readonly path: Scope; readonly published: boolean }[] = [];
  for (const state of entry.state) {
    const installed = join(root, state.path);
    const staged = join(entry.stage.path, state.path);
    const inTarget = await exists(installed);
    const inStage = await exists(staged);
    if (inTarget === inStage || !matches(await lstat(inTarget ? installed : staged), state)) {
      throw new Error("迁移发布路径已变更，无法安全恢复。");
    }
    result.push({ path: state.path, published: inTarget });
  }
  return result;
}

async function restoreUncommitted(root: string, entry: PublicationEntry) {
  const items = await publicationLocations(root, entry);
  for (const { path, published } of items.reverse()) {
    if (published) await move(join(root, path), join(entry.stage.path, path));
  }
  await removeJournal(pathFor(root, "pending"));
}

async function verifyCommittedDirectories(root: string, entry: PublicationEntry) {
  if (!matches(await lstat(root), entry.target)) throw new Error("目标安装已变更，迁移发布须先核对。");
  for (const state of entry.state) {
    if (!matches(await lstat(join(root, state.path)), state)) throw new Error("已提交的迁移目录缺失或已变更。");
  }
}

async function finishCommitted(root: string, entry: PublicationEntry) {
  await verifyCommittedDirectories(root, entry);
  await move(pathFor(root, "pending"), pathFor(root, "applied"));
}

/** The caller holds the existing managed host lock before reading or starting this checkout. */
export async function recoverMigrationPublicationWithHostLock(target: string) {
  const entry = await readEntry(pathFor(target, "pending"), target);
  if (!entry) return false;
  if (entry.committed) await finishCommitted(target, entry);
  else await restoreUncommitted(target, entry);
  return true;
}

/** The launcher already owns its startup lock. An idle checkout is required only when there is a pending publication. */
export async function recoverMigrationPublicationForStartup(target: string) {
  if (!await exists(pathFor(target, "pending"))) return false;
  const host = await lockFile(managedHostLockPath(target), "托管宿主", 0, "当前目录已有托管宿主运行。");
  try {
    return await recoverMigrationPublicationWithHostLock(target);
  } finally {
    host.close();
  }
}

async function requireLotusCheckout(root: string) {
  const git = createLocalGit();
  const topLevel = (await git?.(root, ["rev-parse", "--show-toplevel"]))?.trimEnd();
  const manifest = join(root, "package.json");
  if (!topLevel || await realpath(topLevel) !== root) throw new Error("迁移目标须是独立的 Lotus-Yunzai Git 工作区。");
  const info = await lstat(manifest);
  if (!info.isFile() || info.size > 256 * 1024 || (await Bun.file(manifest).json())?.name !== "lotus-yunzai") {
    throw new Error("迁移目标须是独立的 Lotus-Yunzai Git 工作区。");
  }
}

/** Installs an already validated same-filesystem payload into an idle checkout. Verification runs while startup remains locked. */
export async function publishMigrationPayload(
  targetDirectory: string,
  payloadDirectory: string,
  verify?: (target: string) => Promise<void>,
) {
  const [root, stage] = await Promise.all([realpath(targetDirectory), realpath(payloadDirectory)]);
  const startup = await lockFile(managedStartupLockPath(root), "启动操作", 0);
  try {
    const host = await lockFile(managedHostLockPath(root), "托管宿主", 0, "当前目录已有托管宿主运行。");
    try {
      await recoverUpdateActivation(root);
      await recoverMigrationPublicationWithHostLock(root);
      await requireLotusCheckout(root);
      const target = identity(await lstat(root));
      const staged = identity(await lstat(stage));
      if (target.dev !== staged.dev || target.ino === staged.ino || within(root, stage) || within(stage, root)) {
        throw new Error("迁移暂存与目标须是同一文件系统内的独立目录。");
      }
      const receipt = await readEntry(pathFor(root, "applied"), root);
      if (receipt) {
        if (receipt.committed && receipt.stage.path === stage && receipt.stage.dev === staged.dev && receipt.stage.ino === staged.ino &&
            receipt.target.dev === target.dev && receipt.target.ino === target.ino) {
          await verifyCommittedDirectories(root, receipt);
          return { status: "already-published", paths: receipt.state.map(item => item.path) } as const;
        }
        throw new Error("该目标已有另一份迁移结果，不能直接覆盖。");
      }
      const names = (await readdir(stage)).sort();
      if (!names.length || !names.every(isScope)) throw new Error("迁移暂存只接受已验证的 config、data、backup 目录。");
      const state = [];
      for (const path of names) {
        if (await exists(join(root, path))) throw new Error(`迁移目标已有 ${path}，不能直接覆盖。`);
        const directory = identity(await lstat(join(stage, path)));
        if (directory.dev !== target.dev) throw new Error("迁移目录跨文件系统。");
        await syncPayload(join(stage, path), target.dev);
        state.push({ path, ...directory });
      }
      await syncDirectory(stage);
      const entry: PublicationEntry = { version: 1, target, stage: { path: stage, ...staged }, state, committed: false };
      const pending = pathFor(root, "pending");
      await publicationLocations(root, entry);
      await writeJournal(pending, entry, true);
      try {
        for (const { path } of state) await move(join(stage, path), join(root, path));
        await verify?.(root);
        const locations = await publicationLocations(root, entry);
        if (!locations.every(item => item.published)) throw new Error("迁移目录未全部发布。");
      } catch (error) {
        await restoreUncommitted(root, entry);
        throw error;
      }
      const committed = { ...entry, committed: true };
      await writeJournal(pending, committed, false);
      await finishCommitted(root, committed);
      return { status: "published", paths: state.map(item => item.path) } as const;
    } finally {
      host.close();
    }
  } finally {
    startup.close();
  }
}
