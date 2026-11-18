import { cp, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { builtInDirectories } from "./builtin-modules.ts";
import { createLocalGit, gitHead, isGitCheckout } from "./local-git.ts";
import { loadedPluginPath, type PluginDirectories } from "./plugins/loaded-directories.ts";
import { activateUpdate } from "./update-activation.ts";
import { buildUpdateCheckout, initializeUpdateSubmodules } from "./update-build.ts";
import { isUpdateWorktreeDirty } from "./update-candidate-git.ts";
import { checkoutUpdateRevision } from "./update-checkout.ts";
import { verifyUpdateHealth } from "./update-health.ts";
import type { ReadyUpdate } from "./update-preflight.ts";
import { restoreUpdateTracking } from "./update-tracking.ts";

const builtIns = new Set(builtInDirectories.values());

function within(parent: string, path: string): boolean {
  const subpath = relative(parent, path);
  return subpath !== ".." && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath);
}

async function readActiveRevision(directory: string): Promise<string> {
  const git = createLocalGit();
  if (!git || !await isGitCheckout(git, directory)) throw new Error("无有效的 Git 工作区。");
  const [head, dirty] = await Promise.all([gitHead(git, directory), isUpdateWorktreeDirty(git, directory)]);
  if (!head || dirty !== false) throw new Error("Git 工作区存在修改或不可读。");
  return head;
}

async function copyLocalPlugin(source: string, destination: string) {
  await cp(source, destination, {
    recursive: true, force: false, errorOnExist: true,
    async filter(path) {
      const name = basename(path);
      if (path !== source && (name === "node_modules" || name === ".git" || name === ".env" || name.startsWith(".env."))) {
        return false;
      }
      const info = await lstat(path);
      if (!info.isDirectory() && !info.isFile()) throw new Error("本地插件包含无法隔离的文件。");
      return true;
    },
  });
}

async function verifyStagedPins(directory: string) {
  const git = createLocalGit();
  const listing = await git?.(directory, ["ls-tree", "-r", "-z", "HEAD"]);
  if (listing === undefined) throw new Error("无法检查候选子模块提交。");
  const pins = listing.split("\0").flatMap((line) => {
    const match = /^160000 commit ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(line);
    return match?.[1] && match[2] ? [{ revision: match[1], path: match[2] }] : [];
  });
  for (const { path, revision } of pins) {
    const child = join(directory, path);
    if (!within(directory, child) || await realpath(child) !== child || await readActiveRevision(child) !== revision) {
      throw new Error("候选子模块未检出固定提交。");
    }
    await verifyStagedPins(child);
  }
}

async function trackedPluginNames(directory: string): Promise<Set<string>> {
  const git = createLocalGit();
  const result = await git?.(directory, ["ls-tree", "-z", "--name-only", "HEAD:plugins"], true);
  if (result !== undefined) return new Set(result.split("\0").filter(Boolean));
  // Repositories that keep all plugins untracked have no plugins tree in HEAD.
  const rootEntries = await git?.(directory, ["ls-tree", "-z", "--name-only", "HEAD", "--", "plugins"]);
  if (rootEntries === "") return new Set();
  throw new Error("无法检查宿主跟踪的插件目录。");
}

async function probeStagedUpdate(directory: string, revision: string) {
  const paths = ["config", "data", "logs"].map((name) => join(directory, name));
  for (const path of paths) {
    try {
      await lstat(path);
      throw new Error("候选目录已包含运行状态。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
  }
  try {
    await verifyUpdateHealth(directory, revision);
  } finally {
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
  }
}

export async function stageUpdate(root: URL, directories: PluginDirectories, ready: ReadyUpdate, stagingParent = tmpdir()) {
  let staging: string | undefined;
  let phase = "校验当前工作区";
  try {
    const [host, parent] = await Promise.all([realpath(fileURLToPath(root)), realpath(stagingParent)]);
    if (within(host, parent)) throw new Error("候选目录必须位于活动宿主之外。");
    const hostHead = await readActiveRevision(host);
    if (ready.scope === "host" && (ready.directory !== host || ready.current !== hostHead)) {
      throw new Error("宿主提交已变更。");
    }

    phase = "检出宿主候选";
    staging = await mkdtemp(join(parent, "lotus-update-"));
    const directory = join(staging, "checkout");
    const cache = join(staging, "bun-cache");
    await mkdir(cache);
    const stagedHead = ready.scope === "host" ? ready.candidate : hostHead;
    await checkoutUpdateRevision(host, stagedHead, directory);

    phase = "准备外部插件";
    const pluginRoot = join(directory, "plugins");
    await mkdir(pluginRoot, { recursive: true });
    if (await realpath(pluginRoot) !== pluginRoot) throw new Error("候选插件目录无效。");
    const [trackedActive, trackedCandidate] = await Promise.all([trackedPluginNames(host), trackedPluginNames(directory)]);
    const copies: { source: string; head: string; destination: string; stagedHead: string }[] = [];
    let selected = ready.scope === "host";
    for (const [name, plugin] of directories) {
      if (builtIns.has(name)) continue;
      if (trackedActive.has(name)) {
        if (ready.scope === "plugin" && name === ready.name) throw new Error("插件由宿主提交管理。");
        continue;
      }
      if (trackedCandidate.has(name)) throw new Error("候选占用活动插件目录。");
      const source = await loadedPluginPath(host, { ...plugin, name });
      if (!source) throw new Error("活动插件目录已变更。");
      const destination = join(pluginRoot, name);
      const git = createLocalGit();
      if (!git) throw new Error("无法检查插件工作区。");
      if (!await isGitCheckout(git, source)) {
        if (ready.scope === "plugin" && name === ready.name) throw new Error("候选插件的 Git 工作区已变更。");
        await copyLocalPlugin(source, destination);
        continue;
      }
      const head = await readActiveRevision(source);
      let revision = head;
      if (ready.scope === "plugin" && name === ready.name) {
        if (ready.directory !== source || ready.current !== head) throw new Error("插件提交已变更。");
        revision = ready.candidate;
        selected = true;
      }
      await checkoutUpdateRevision(source, revision, destination);
      await initializeUpdateSubmodules(destination, cache);
      copies.push({ source, head, destination, stagedHead: revision });
    }
    if (!selected) throw new Error("候选插件未加载。");

    phase = "运行候选初始化和类型检查";
    await buildUpdateCheckout(directory, cache);

    async function checkRevisions() {
      if (await readActiveRevision(host) !== hostHead || await readActiveRevision(directory) !== stagedHead) {
        throw new Error("宿主检查期间已变更。");
      }
      for (const plugin of copies) {
        if (await readActiveRevision(plugin.source) !== plugin.head ||
            await readActiveRevision(plugin.destination) !== plugin.stagedHead) throw new Error("插件检查期间已变更。");
      }
    }

    phase = "核验候选提交和活动工作区";
    await checkRevisions();
    await verifyStagedPins(directory);
    for (const plugin of copies) {
      await verifyStagedPins(plugin.destination);
    }

    phase = "恢复候选更新跟踪";
    await restoreUpdateTracking(host, directory, hostHead, stagedHead);
    for (const plugin of copies) {
      await restoreUpdateTracking(plugin.source, plugin.destination, plugin.head, plugin.stagedHead);
    }

    const owned = staging;
    let cleanup: Promise<void> | undefined;
    let activating = false;
    return {
      directory, revision: stagedHead,
      async activate(verify: (active: string) => Promise<void>, additionalStatePaths?: readonly string[]) {
        if (activating || cleanup) throw new Error("候选正在使用或已释放。");
        activating = true;
        try {
          await probeStagedUpdate(directory, stagedHead);
          return await activateUpdate(host, directory, verify, additionalStatePaths, async () => {
            await checkRevisions();
            await ready.release();
          });
        } finally {
          activating = false;
        }
      },
      async release() {
        if (activating) throw new Error("候选正在切换。");
        return cleanup ??= rm(owned, { recursive: true, force: true })
          .catch((error: unknown) => { cleanup = undefined; throw error; });
      },
    };
  } catch {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw new Error(`更新候选构建失败（${phase}）。`);
  }
}
