import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lockFile, managedHostLockPath, managedStartupLockPath } from "./file-lock.ts";
import { exists, move, removeJournal, syncDirectory, writeJournal } from "./filesystem-transaction.ts";
import { isManagedLegacyScript, isManagedPluginDirectory } from "./managed-update-protocol.ts";
import { createLocalGit } from "./local-git.ts";
import { recoverUpdateActivation } from "./update-activation.ts";

const scopes = ["config", "data", "backup"] as const;
const journalLimit = 64 * 1024;

type Scope = (typeof scopes)[number];
type PluginPath = `plugins/${string}`;
type PublishedPath = Scope | PluginPath;

interface PublishedEntry extends PhysicalDirectory {
  readonly path: PublishedPath;
  readonly kind?: "file";
}
interface PhysicalDirectory {
  readonly dev: number;
  readonly ino: number;
}
interface PublicationEntry {
  readonly version: 1;
  readonly target: PhysicalDirectory;
  readonly stage: PhysicalDirectory & { readonly path: string };
  readonly state: readonly PublishedEntry[];
  readonly pluginParents?: { readonly target: PhysicalDirectory; readonly stage: PhysicalDirectory };
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

function isPluginPath(path: string): path is PluginPath {
  const [parent, candidate, ...rest] = path.split("/");
  return parent === "plugins" && !rest.length && isManagedPluginDirectory(candidate) &&
    !candidate.startsWith(".") && candidate !== "node_modules";
}

function identity(info: Stats): PhysicalDirectory {
  if (!info.isDirectory()) throw new Error("迁移发布路径须为实体目录。");
  return { dev: info.dev, ino: info.ino };
}

function matches(info: Stats, expected: PhysicalDirectory, kind?: "file") {
  return (kind === "file" ? info.isFile() : info.isDirectory()) && info.dev === expected.dev && info.ino === expected.ino;
}

function recordedPhysical(value: unknown): value is PhysicalDirectory {
  if (!value || typeof value !== "object") return false;
  const physical = value as Partial<PhysicalDirectory>;
  return Number.isSafeInteger(physical.dev) && Number.isSafeInteger(physical.ino) &&
    physical.dev! >= 0 && physical.ino! > 0;
}

function recordedState(value: unknown, device: number): value is PublishedEntry {
  if (!recordedPhysical(value) || !("path" in value) || typeof value.path !== "string" || value.dev !== device) return false;
  const kind = "kind" in value ? value.kind : undefined;
  return (isScope(value.path) || isPluginPath(value.path)) &&
    (kind === undefined || (kind === "file" && isPluginPath(value.path) && isManagedLegacyScript(value.path)));
}

async function readEntry(path: string, root: string) {
  if (!await exists(path)) return;
  const input = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await input.stat();
    if (!info.isFile() || info.size > journalLimit) throw new Error("迁移发布记录无效。");
    let interruptedLink: string | undefined;
    if (info.nlink === 2 && path === pathFor(root, "pending")) {
      // An interrupted exclusive publication can leave its own temporary link in place.
      const prefix = basename(path) + ".";
      const suffix = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
      for (const name of await readdir(dirname(path))) {
        if (!name.startsWith(prefix) || !suffix.test(name.slice(prefix.length))) continue;
        const temporary = join(dirname(path), name);
        const link = await lstat(temporary);
        if (link.isFile() && link.dev === info.dev && link.ino === info.ino) {
          interruptedLink = temporary;
          break;
        }
      }
    }
    if (info.nlink !== 1 && !interruptedLink) throw new Error("迁移发布记录无效。");
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await input.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error("迁移发布记录无效。");
    const entry = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as PublicationEntry;
    if (!entry || entry.version !== 1 || typeof entry.committed !== "boolean" || !recordedPhysical(entry.target) ||
        !recordedPhysical(entry.stage) || typeof entry.stage.path !== "string" || !isAbsolute(entry.stage.path) ||
        resolve(entry.stage.path) !== entry.stage.path || within(root, entry.stage.path) || within(entry.stage.path, root) ||
        entry.stage.dev !== entry.target.dev || !Array.isArray(entry.state) ||
        !entry.state.length || !entry.state.every((item: unknown) => recordedState(item, entry.target.dev)) ||
        new Set(entry.state.map(item => item.path)).size !== entry.state.length) throw new Error("迁移发布记录无效。");
    if (entry.state.some(item => isPluginPath(item.path))) {
      if (!entry.pluginParents || !recordedPhysical(entry.pluginParents.target) || !recordedPhysical(entry.pluginParents.stage) ||
          entry.pluginParents.target.dev !== entry.target.dev || entry.pluginParents.stage.dev !== entry.target.dev) {
        throw new Error("迁移插件父目录记录无效。");
      }
    } else if (entry.pluginParents !== undefined) throw new Error("迁移插件父目录记录无效。");
    if (interruptedLink) {
      await unlink(interruptedLink);
      await syncDirectory(dirname(path));
    }
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

async function requirePluginParents(root: string, entry: PublicationEntry, verifyStage: boolean) {
  const parents = entry.pluginParents;
  if (parents && (!matches(await lstat(join(root, "plugins")), parents.target) ||
      (verifyStage && !matches(await lstat(join(entry.stage.path, "plugins")), parents.stage)))) {
    throw new Error("迁移插件父目录已变更或已被替换为符号链接。");
  }
}

async function publicationLocations(root: string, entry: PublicationEntry) {
  if (!matches(await lstat(root), entry.target) || !matches(await lstat(entry.stage.path), entry.stage) ||
      await realpath(entry.stage.path) !== entry.stage.path) throw new Error("目标或暂存目录已变更，无法恢复迁移发布。");
  await requirePluginParents(root, entry, true);
  const result: { readonly path: PublishedPath; readonly published: boolean }[] = [];
  for (const state of entry.state) {
    const installed = join(root, state.path);
    const staged = join(entry.stage.path, state.path);
    const inTarget = await exists(installed);
    const inStage = await exists(staged);
    if (inTarget === inStage || !matches(await lstat(inTarget ? installed : staged), state, state.kind)) {
      throw new Error("迁移发布路径已变更，无法安全恢复。");
    }
    result.push({ path: state.path, published: inTarget });
  }
  return result;
}

async function restoreUncommitted(root: string, entry: PublicationEntry) {
  const items = await publicationLocations(root, entry);
  for (const { path, published } of items.reverse()) {
    if (published) {
      if (isPluginPath(path)) await requirePluginParents(root, entry, true);
      await move(join(root, path), join(entry.stage.path, path));
    }
  }
  await removeJournal(pathFor(root, "pending"));
}

async function verifyCommittedDirectories(root: string, entry: PublicationEntry) {
  if (!matches(await lstat(root), entry.target)) throw new Error("目标安装已变更，迁移发布须先核对。");
  await requirePluginParents(root, entry, false);
  for (const state of entry.state) {
    if (!matches(await lstat(join(root, state.path)), state, state.kind)) throw new Error("已提交的迁移路径缺失或已变更。");
  }
}

async function verifyAppliedPublication(root: string, current: PhysicalDirectory, entry: PublicationEntry) {
  if (current.ino === entry.target.ino) return verifyCommittedDirectories(root, entry);

  // A managed update replaces the checkout and copies local plugins, then moves the persistent roots intact.
  const persistent = entry.state.filter(item => isScope(item.path));
  if (!persistent.length) throw new Error("已迁移的目标已更换，缺少可核对的持久目录。");
  for (const item of persistent) {
    if (!matches(await lstat(join(root, item.path)), item)) throw new Error("已迁移的持久目录已变更，不能继续核对。");
  }
  const plugins = entry.state.filter(item => isPluginPath(item.path));
  if (plugins.length && !(await lstat(join(root, "plugins"))).isDirectory()) {
    throw new Error("已迁移的插件根目录已变更，不能继续核对。");
  }
  for (const item of plugins) {
    const present = await lstat(join(root, item.path));
    if (!(item.kind === "file" ? present.isFile() : present.isDirectory())) {
      throw new Error("已迁移的插件路径已变更，不能继续核对。");
    }
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

async function collectApprovedPlugins(root: string, stage: string, approvals: readonly string[]) {
  const approved = new Set(approvals);
  if (approved.size !== approvals.length || !approvals.every(isPluginPath)) throw new Error("兼容插件核准路径无效。");
  const stagedRoot = join(stage, "plugins");
  if (!await exists(stagedRoot)) {
    if (approvals.length) throw new Error("兼容插件暂存与核准清单不一致。");
    return;
  }
  const stageInfo = await lstat(stagedRoot);
  if (!stageInfo.isDirectory()) throw new Error("暂存插件根须为实体目录。");
  const candidates = (await readdir(stagedRoot)).sort().map(name => `plugins/${name}`);
  const paths = candidates.filter(isPluginPath);
  if (paths.length !== candidates.length || paths.length !== approvals.length || paths.some(path => !approved.has(path))) {
    throw new Error("兼容插件暂存与核准清单不一致。");
  }
  if (!paths.length) return;
  const target = await lstat(join(root, "plugins"));
  if (!target.isDirectory()) throw new Error("目标插件根须为实体目录。");
  const git = createLocalGit();
  const [head, index] = await Promise.all([
    git?.(root, ["ls-tree", "-z", "--name-only", "HEAD:plugins"]),
    git?.(root, ["ls-files", "-z", "--", "plugins"]),
  ]);
  if (head === undefined || index === undefined) throw new Error("无法核对目标插件跟踪路径。");
  const protectedNames = new Set(head.split("\0"));
  for (const entry of index.split("\0")) {
    const name = entry.split("/")[1];
    if (name !== undefined) protectedNames.add(name);
  }
  for (const path of paths) {
    if (protectedNames.has(path.slice("plugins/".length))) throw new Error(`迁移插件与目标 Git 跟踪路径冲突：${path}。`);
  }
  return { paths, parents: { target: identity(target), stage: identity(stageInfo) } };
}

/** Installs an already validated same-filesystem payload into an idle checkout. Verification runs while startup remains locked. */
export async function publishMigrationPayload(
  targetDirectory: string,
  payloadDirectory: string,
  verify?: (target: string) => Promise<void>,
  approvedPlugins: readonly string[] = [],
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
            receipt.target.dev === target.dev) {
          const paths = receipt.state.map(item => item.path);
          const approved = new Set(approvedPlugins);
          const pluginPaths = paths.filter(isPluginPath);
          if (pluginPaths.length !== approvedPlugins.length || pluginPaths.some(path => !approved.has(path))) {
            throw new Error("兼容插件核准清单与迁移结果不一致。");
          }
          await verifyAppliedPublication(root, target, receipt);
          return { status: "already-published", paths } as const;
        }
        throw new Error("该目标已有另一份迁移结果，不能直接覆盖。");
      }
      const names = (await readdir(stage)).sort();
      if (!names.every(name => isScope(name) || name === "plugins")) {
        throw new Error("迁移暂存只接受已验证的 config、data、backup 和兼容插件。");
      }
      const plugins = await collectApprovedPlugins(root, stage, approvedPlugins);
      const paths = [...names.filter(isScope), ...(plugins?.paths ?? [])];
      if (!paths.length) throw new Error("迁移暂存未包含可发布的路径。");
      const state: PublishedEntry[] = [];
      for (const path of paths) {
        if (await exists(join(root, path))) throw new Error(`迁移目标已有 ${path}，不能直接覆盖。`);
        const payload = join(stage, path);
        const original = await lstat(payload);
        if (original.dev !== target.dev) throw new Error("迁移路径跨文件系统。");
        const script = original.isFile() && isPluginPath(path) && isManagedLegacyScript(path);
        if (script && original.nlink !== 1) throw new Error("兼容插件脚本须为无硬链接的普通文件。");
        const physical = script ? { dev: original.dev, ino: original.ino, kind: "file" as const } : identity(original);
        await syncPayload(payload, target.dev);
        state.push({ path, ...physical });
      }
      await syncDirectory(stage);
      const entry: PublicationEntry = { version: 1, target, stage: { path: stage, ...staged }, state, committed: false,
        ...(plugins && { pluginParents: plugins.parents }) };
      if (Buffer.byteLength(JSON.stringify(entry)) > journalLimit) throw new Error("迁移发布记录超过大小上限。");
      const pending = pathFor(root, "pending");
      await publicationLocations(root, entry);
      await writeJournal(pending, entry, true);
      try {
        for (const { path } of state) {
          if (isPluginPath(path)) await requirePluginParents(root, entry, true);
          await move(join(stage, path), join(root, path));
        }
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
