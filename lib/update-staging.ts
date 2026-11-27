import { seedUpdateSubmodules } from "./update-submodules.ts";
import type { ManagedUpdateProgress } from "./managed-update-protocol.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { builtInDirectories } from "./builtin-modules.ts";
import { readInstallCatalog } from "./install-catalog.ts";
import type { ReadyInstall } from "./install-preflight.ts";
import { createLocalGit, gitHead, isGitCheckout, type LocalGit } from "./local-git.ts";
import { copyLocalPlugin } from "./plugins/local-plugin-copy.ts";
import { loadedPluginPath, type PluginDirectories } from "./plugins/loaded-directories.ts";
import { activateUpdate } from "./update-activation.ts";
import { buildExternalPluginCheckout, buildUpdateCheckout, initializeUpdateSubmodules } from "./update-build.ts";
import { isUpdateWorktreeDirty, updateBindingFingerprint } from "./update-candidate-git.ts";
import { checkoutUpdateRevision } from "./update-checkout.ts";
import { verifyUpdateHealth } from "./update-health.ts";
import type { ReadyBatchUpdate, ReadyUpdate } from "./update-preflight.ts";
import { restoreUpdateTracking } from "./update-tracking.ts";

const builtIns = new Set(builtInDirectories.values());
const pluginStateDirectories = ["config", "data", "logs"];
const builtInStateDirectories = [...pluginStateDirectories, "assets", "resources"];

function within(parent: string, path: string): boolean {
  const subpath = relative(parent, path);
  return subpath !== ".." && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath);
}

type SourcePolicy = Pick<ReadyUpdate, "force" | "binding">;

async function readActiveRevision(directory: string, signal?: AbortSignal, policy?: SourcePolicy): Promise<string> {
  signal?.throwIfAborted();
  const git = createLocalGit();
  if (!git || !await isGitCheckout(git, directory)) throw new Error($t("lib.update-staging.text_efab2eccfb"));
  const [head, dirty] = await Promise.all([gitHead(git, directory), isUpdateWorktreeDirty(git, directory)]);
  if ((policy?.binding || policy?.force) && (!policy.binding || await updateBindingFingerprint(git, directory) !== policy.binding)) {
    throw new Error($t("lib.update-staging.text_7ac8304217"));
  }
  if (policy?.force) await verifyArchiveSource(git, directory);
  signal?.throwIfAborted();
  if (!head || dirty === undefined || (dirty && !policy?.force)) throw new Error($t("lib.update-staging.text_d5f7d26234"));
  return head;
}

async function verifyArchiveSource(git: LocalGit, source: string) {
  const marker = join(source, ".git");
  const error = () => new Error($t("lib.update-staging.text_e22bf5d326"));
  if (!(await lstat(marker)).isDirectory()) throw error();
  const [common, worktree, metadata] = await Promise.all([
    git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(source, ["config", "--null", "--get-all", "core.worktree"], true),
    readdir(marker, { withFileTypes: true }),
  ]);
  if (common !== marker + "\n" || worktree !== "" ||
      metadata.some((entry) => entry.isSymbolicLink() || entry.name === "commondir")) throw error();
  if (metadata.some((entry) => entry.name === "worktrees") && (await readdir(join(marker, "worktrees"))).length) throw error();
  for (const { name } of metadata) {
    if (name !== "refs" && name !== "logs" && name !== "objects") continue;
    const entries = await readdir(join(marker, name), { recursive: true, withFileTypes: true });
    if (entries.some((entry) => entry.isSymbolicLink() ||
      (name === "objects" && (entry.name === "alternates" || entry.name === "http-alternates")))) throw error();
  }
}

async function verifyArchiveState(host: string, source: string, state: readonly string[]) {
  const affected: string[] = [];
  for (const path of state) {
    const location = join(host, path);
    if (within(location, source)) throw new Error($t("lib.update-staging.text_bdd0f4632d"));
    if (within(source, location)) affected.push(relative(source, location));
  }
  if (!affected.length) return;
  const git = createLocalGit();
  const [head, index] = await Promise.all([
    git?.(source, ["ls-tree", "-r", "-z", "HEAD"]),
    git?.(source, ["ls-files", "--stage", "-z"]),
  ]);
  if (head === undefined || index === undefined) throw new Error($t("lib.update-staging.text_2672be7caf"));
  const paths = new Set(affected);
  const parents = new Set<string>();
  for (const path of paths) {
    for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) parents.add(parent);
  }
  const childRepositories = new Set<string>();
  for (const entry of [...head.split("\0"), ...index.split("\0")]) {
    const tracked = entry.slice(entry.indexOf("\t") + 1);
    if (parents.has(tracked)) {
      if (!entry.startsWith("160000 ")) throw new Error($t("lib.update-staging.text_df581cf3fe"));
      childRepositories.add(join(source, tracked));
      continue;
    }
    for (let path = tracked; path !== "." && path; path = dirname(path)) {
      if (paths.has(path)) throw new Error($t("lib.update-staging.text_df581cf3fe"));
    }
  }
  for (const child of childRepositories) {
    if (!git || !await isGitCheckout(git, child)) throw new Error($t("lib.update-staging.text_08798afd79"));
    await verifyArchiveState(host, child, state);
  }
}

async function verifyStagedPins(directory: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const git = createLocalGit();
  const listing = await git?.(directory, ["ls-tree", "-r", "-z", "HEAD"]);
  signal?.throwIfAborted();
  if (listing === undefined) throw new Error($t("lib.update-staging.text_d8301a28a9"));
  const pins = listing.split("\0").flatMap((line) => {
    const match = /^160000 commit ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(line);
    return match?.[1] && match[2] ? [{ revision: match[1], path: match[2] }] : [];
  });
  for (const { path, revision } of pins) {
    const child = join(directory, path);
    if (!within(directory, child) || await realpath(child) !== child || await readActiveRevision(child, signal) !== revision) {
      throw new Error($t("lib.update-staging.text_390b41d6d0"));
    }
    await verifyStagedPins(child, signal);
  }
}

async function trackedPluginNames(directory: string): Promise<Set<string>> {
  const git = createLocalGit();
  const result = await git?.(directory, ["ls-tree", "-z", "--name-only", "HEAD:plugins"], true);
  if (result !== undefined) return new Set(result.split("\0").filter(Boolean));
  // Repositories that keep all plugins untracked have no plugins tree in HEAD.
  const rootEntries = await git?.(directory, ["ls-tree", "-z", "--name-only", "HEAD", "--", "plugins"]);
  if (rootEntries === "") return new Set();
  throw new Error($t("lib.update-staging.text_2573eb14d1"));
}

async function unmanagedPluginPaths(host: string, managed: ReadonlySet<string>): Promise<string[]> {
  const root = join(host, "plugins");
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error($t("lib.update-staging.text_2fd90f3feb"));
    return (await readdir(root)).filter((name) => name !== "node_modules" && !managed.has(name))
      .sort().map((name) => `plugins/${name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    throw error;
  }
}

function dotenvFile(name: string): boolean {
  return name === ".env" || name.startsWith(".env.");
}

async function pluginStatePaths(
  source: string, tracked: boolean, stateDirectories = pluginStateDirectories,
): Promise<string[]> {
  if (await realpath(source) !== source) throw new Error($t("lib.update-staging.text_ab6672606a"));
  const paths = (await readdir(source)).filter((name) => dotenvFile(name) ||
    (tracked && stateDirectories.includes(name)));
  if (!tracked || !paths.length) return paths.map((path) => `plugins/${basename(source)}/${path}`);
  const git = createLocalGit();
  const output = await git?.(source, ["ls-files", "-z", "--cached", "--", ...paths]);
  if (output === undefined) throw new Error($t("lib.update-staging.text_bcbbe5aad3"));
  const managed = new Set(output.split("\0").filter(Boolean).map((path) => path.split("/")[0]));
  const untracked = paths.filter((path) => !managed.has(path));
  const sharedPaths = paths.filter((path) => managed.has(path) && !dotenvFile(path));
  if (sharedPaths.length) {
    const files = await git?.(source, ["ls-files", "-z", "--others", "--directory", "--no-empty-directory", "--", ...sharedPaths]);
    if (files === undefined) throw new Error($t("lib.update-staging.text_5d842511e9"));
    untracked.push(...files.split("\0").filter(Boolean).map((path) => path.replace(/\/$/u, "")));
  }
  return untracked.map((path) => `plugins/${basename(source)}/${path}`);
}

async function probeStagedUpdate(
  directory: string, revision: string, additionalStatePaths: readonly string[], signal?: AbortSignal,
) {
  const paths = ["config", "data", "logs", ...additionalStatePaths].map((name) => join(directory, name));
  async function verifyParent(path: string) {
    let parent = dirname(path);
    if (!within(directory, parent)) throw new Error($t("lib.update-staging.text_1de9964b9a"));
    while (parent !== directory) {
      try {
        if (await realpath(parent) !== parent) throw new Error($t("lib.update-staging.text_bd9579fbe1"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
      }
      parent = dirname(parent);
    }
  }
  for (const path of paths) {
    await verifyParent(path);
    try {
      await lstat(path);
      throw new Error($t("lib.update-staging.text_c80696b8bd"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
  }
  try {
    await verifyUpdateHealth(directory, revision, signal);
  } finally {
    await Promise.all(paths.map(async (path) => {
      await verifyParent(path);
      await rm(path, { force: true, recursive: true });
    }));
  }
}

export async function stageUpdate(
  root: URL, directories: PluginDirectories, ready: ReadyUpdate | ReadyBatchUpdate | ReadyInstall,
  stagingParent = tmpdir(), signal?: AbortSignal, report?: (status: ManagedUpdateProgress) => void,
) {
  let staging: string | undefined;
  let phase = $t("lib.update-staging.text_bd67fba743");
  try {
    signal?.throwIfAborted();
    const [host, parent] = await Promise.all([realpath(fileURLToPath(root)), realpath(stagingParent)]);
    if (within(host, parent)) throw new Error($t("lib.update-staging.text_b974aca0d2"));
    const hostTarget = ready.scope === "all" ? ready.host : ready.scope === "host" ? ready : undefined;
    const hostHead = await readActiveRevision(host, signal, hostTarget);
    if (hostTarget && (hostTarget.directory !== host || hostTarget.current !== hostHead)) {
      throw new Error($t("lib.update-staging.text_208b691c55"));
    }
    const installation = ready.scope === "install" ? ready : undefined;
    if (installation && (installation.host.directory !== host || installation.host.current !== hostHead)) {
      throw new Error($t("lib.update-staging.text_208b691c55"));
    }
    const targets = new Map<string, ReadyUpdate>(
      ready.scope === "all" ? ready.plugins : ready.scope === "plugin" ? [[ready.name, ready]] : [],
    );
    for (const [name, target] of targets) {
      if (target.scope !== "plugin" || target.name !== name || !directories.has(name) || builtIns.has(name)) {
        throw new Error($t("lib.update-staging.text_be7fff4464"));
      }
    }

    phase = $t("lib.update-staging.text_6bd6e2b1e6");
    report?.("phase:checkout");
    staging = await mkdtemp(join(parent, "lotus-update-"));
    const directory = join(staging, "checkout");
    const cache = join(staging, "bun-cache");
    await mkdir(cache);
    const stagedHead = hostTarget?.candidate ?? hostHead;
    await checkoutUpdateRevision(host, stagedHead, directory, signal);

    phase = $t("lib.update-staging.text_557a75add7");
    report?.("phase:submodules");
    await seedUpdateSubmodules(host, directory, signal);
    await initializeUpdateSubmodules(directory, cache, signal);
    const pluginRoot = join(directory, "plugins");
    await mkdir(pluginRoot, { recursive: true });
    if (await realpath(pluginRoot) !== pluginRoot) throw new Error($t("lib.update-staging.text_e7aa5dafcd"));
    const [trackedActive, trackedCandidate] = await Promise.all([trackedPluginNames(host), trackedPluginNames(directory)]);
    const retainedBuiltIns = [...builtIns].filter((name) => trackedActive.has(name) && trackedCandidate.has(name));
    const copies: { source: string; head: string; destination: string; stagedHead: string; target?: ReadyUpdate }[] = [];
    const localCopies: string[] = [];
    for (const [name, plugin] of directories) {
      signal?.throwIfAborted();
      if (builtIns.has(name)) continue;
      const target = targets.get(name);
      if (trackedActive.has(name)) {
        if (target) throw new Error($t("lib.update-staging.text_da738c27e5"));
        continue;
      }
      if (trackedCandidate.has(name)) throw new Error($t("lib.update-staging.text_2d540d1a9a"));
      const source = await loadedPluginPath(host, { ...plugin, name });
      if (!source) throw new Error($t("lib.update-staging.text_f49aaf59ed"));
      const destination = join(pluginRoot, name);
      const git = createLocalGit();
      if (!git) throw new Error($t("lib.update-staging.text_1d017cedbb"));
      if (!await isGitCheckout(git, source)) {
        if (target) throw new Error($t("lib.update-staging.text_f98aea3056"));
        await copyLocalPlugin(source, destination, signal);
        localCopies.push(source);
        continue;
      }
      const head = await readActiveRevision(source, signal, target);
      let revision = head;
      if (target) {
        if (target.directory !== source || target.current !== head) throw new Error($t("lib.update-staging.text_33a53d66f5"));
        revision = target.candidate;
      }
      await checkoutUpdateRevision(source, revision, destination, signal);
      await initializeUpdateSubmodules(destination, cache, signal);
      copies.push({ source, head, destination, stagedHead: revision, target });
      targets.delete(name);
    }
    if (targets.size) throw new Error($t("lib.update-staging.text_5f274f23d0"));

    const managed = new Set([
      ...trackedActive, ...copies.map(({ source }) => basename(source)), ...localCopies.map((source) => basename(source)),
    ]);
    const unmanaged = await unmanagedPluginPaths(host, managed);
    if (unmanaged.some((path) => trackedCandidate.has(basename(path)))) {
      throw new Error($t("lib.update-staging.text_2d540d1a9a"));
    }
    if (installation) {
      const { name, source, revision } = installation.plugin;
      const destination = join(pluginRoot, name);
      if (builtIns.has(name) || directories.has(name) || trackedActive.has(name) || trackedCandidate.has(name) ||
          unmanaged.includes(`plugins/${name}`) || relative(pluginRoot, destination) !== name) {
        throw new Error($t("lib.update-staging.text_6b2bf209a5"));
      }
      await checkoutUpdateRevision(source, revision, destination, signal);
      copies.push({ source, head: revision, destination, stagedHead: revision });
    }

    phase = $t("lib.update-staging.text_bc8377b3ac");
    report?.("phase:build");
    await buildUpdateCheckout(directory, cache, signal, async () => {
      for (const { source, destination } of copies) {
        await buildExternalPluginCheckout(destination, cache, source === installation?.plugin.source, signal);
      }
      for (const source of localCopies) {
        await buildExternalPluginCheckout(join(pluginRoot, basename(source)), cache, false, signal);
      }
    });

    async function checkRevisions(checkSignal?: AbortSignal) {
      if (await readActiveRevision(host, checkSignal, hostTarget) !== hostHead ||
          await readActiveRevision(directory, checkSignal) !== stagedHead) {
        throw new Error($t("lib.update-staging.text_c5789a7e78"));
      }
      for (const plugin of copies) {
        if (await readActiveRevision(plugin.source, checkSignal, plugin.target) !== plugin.head ||
            await readActiveRevision(plugin.destination, checkSignal) !== plugin.stagedHead) throw new Error($t("lib.update-staging.text_63c997d7d3"));
      }
    }

    phase = $t("lib.update-staging.text_54ff22aead");
    report?.("phase:verify");
    await checkRevisions(signal);
    await verifyStagedPins(directory, signal);
    for (const plugin of copies) {
      await verifyStagedPins(plugin.destination, signal);
    }

    phase = $t("lib.update-staging.text_f1edd375b4");
    signal?.throwIfAborted();
    await restoreUpdateTracking(host, directory, hostHead, stagedHead, hostTarget?.binding);
    for (const plugin of copies) {
      signal?.throwIfAborted();
      await restoreUpdateTracking(plugin.source, plugin.destination, plugin.head, plugin.stagedHead);
    }

    signal?.throwIfAborted();
    const owned = staging;
    let cleanup: Promise<void> | undefined;
    let activating = false;
    async function collectPluginState() {
      const state = await Promise.all([
        ...retainedBuiltIns.map((name) => pluginStatePaths(join(host, "plugins", name), true, builtInStateDirectories)),
        ...copies.filter(({ source }) => source !== installation?.plugin.source).map(({ source }) => pluginStatePaths(source, true)),
        ...localCopies.map((source) => pluginStatePaths(source, false)),
      ]);
      return state.flat().sort();
    }
    return {
      directory, revision: stagedHead,
      async activate(verify: (active: string) => Promise<void>, additionalStatePaths?: readonly string[]) {
        if (activating || cleanup) throw new Error($t("lib.update-staging.text_159a6f1489"));
        activating = true;
        try {
          const state = await collectPluginState();
          await probeStagedUpdate(directory, stagedHead, state, signal);
          const managedState = [...state, ...unmanaged];
          const additional = [...new Set(additionalStatePaths)];
          const extraState = additional.filter(path =>
            !managedState.some(parent => path === parent || path.startsWith(parent + "/")) &&
            !additional.some(parent => path.startsWith(parent + "/")));
          return await activateUpdate(host, directory, verify, [...managedState, ...extraState], async (paths) => {
            await checkRevisions();
            const activeState = await collectPluginState();
            if (activeState.length !== state.length || activeState.some((path, index) => path !== state[index]) ||
                state.some((path) => !paths.includes(path))) {
              throw new Error($t("lib.update-staging.text_9400fac47a"));
            }
            const activePaths = await unmanagedPluginPaths(host, managed);
            if (activePaths.length !== unmanaged.length || activePaths.some((path, index) => path !== unmanaged[index]) ||
                unmanaged.some((path) => !paths.includes(path))) {
              throw new Error($t("lib.update-staging.text_c33c479a25"));
            }
            if (installation) {
              const saved = installation.approval;
              const approved = (await readInstallCatalog(root)).resolve(saved.name);
              if (!approved || approved.directory !== saved.directory || approved.url !== saved.url ||
                  approved.branch !== saved.branch || approved.revision !== saved.revision) {
                throw new Error($t("lib.update-staging.text_9bb27c1589"));
              }
            }
            const forced = [...(hostTarget?.force ? [host] : []), ...copies.filter(({ target }) => target?.force).map(({ source }) => source)];
            await Promise.all(forced.map((source) => verifyArchiveState(host, source, paths)));
            await ready.release();
          });
        } finally {
          activating = false;
        }
      },
      async release() {
        if (activating) throw new Error($t("lib.update-staging.text_3230128d81"));
        return cleanup ??= rm(owned, { recursive: true, force: true })
          .catch((error: unknown) => { cleanup = undefined; throw error; });
      },
    };
  } catch {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    await ready.release().catch(() => {});
    signal?.throwIfAborted();
    throw new Error($t("lib.update-staging.text_f353606704", { "phase": phase }));
  }
}
