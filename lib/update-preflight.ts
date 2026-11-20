import { lstat, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { builtInDirectories } from "./builtin-modules.ts";
import { createLocalGit, isGitCheckout, type LocalGit } from "./local-git.ts";
import { findLoadedPlugin, loadedPluginPath, type PluginDirectories } from "./plugins/loaded-directories.ts";
import { inspectPluginMetadata, pluginScriptExtensions, retiredPluginScript } from "./plugins/metadata.ts";
import { fetchUpdateCandidate, isUpdateWorktreeDirty, updateUpstreamBinding } from "./update-candidate-git.ts";

interface TreeEntry {
  readonly mode: string;
  readonly revision: string;
}

export interface ReadyUpdate {
  readonly status: "ready";
  readonly scope: "host" | "plugin";
  readonly force?: boolean;
  readonly binding?: string;
  readonly name: string;
  readonly directory: string;
  readonly current: string;
  readonly candidate: string;
  readonly changedPaths: readonly string[];
  readonly gitlinks: readonly { path: string; revision: string }[];
  readonly release: () => Promise<void>;
}

export interface ReadyBatchUpdate {
  readonly status: "ready";
  readonly scope: "all";
  readonly force?: boolean;
  readonly host: Pick<ReadyUpdate, "directory" | "current" | "candidate" | "force" | "binding">;
  readonly plugins: ReadonlyMap<string, ReadyUpdate>;
  readonly release: () => Promise<void>;
}

type BlockedUpdate = {
  readonly status: "current" | "ahead" | "diverged" | "dirty" | "unavailable" | "rejected";
  readonly target?: string;
};

type UpdatePreflight = ReadyUpdate | BlockedUpdate;
type Candidate = Pick<ReadyUpdate, "current" | "candidate" | "binding" | "release">;

const builtIns = new Set(builtInDirectories.values());

export async function readTree(git: LocalGit, directory: string, revision: string) {
  const output = await git(directory, ["ls-tree", "-r", "-t", "-z", "--full-tree", revision]);
  if (output === undefined) return;
  const entries = new Map<string, TreeEntry>();
  for (const record of output.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (?:blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(record);
    if (!match?.[1] || !match[2] || !match[3]) return;
    entries.set(match[3], { mode: match[1], revision: match[2] });
  }
  return entries;
}

function isRegularFile(entry: TreeEntry | undefined): entry is TreeEntry {
  return entry?.mode === "100644" || entry?.mode === "100755";
}

async function repositories(git: LocalGit, directory: string): Promise<string[]> {
  if (!await isGitCheckout(git, directory)) return [];
  const output = await git(directory, ["config", "--local", "--no-includes", "--null", "--get-regexp", "^remote\\..*\\.url$"], true);
  if (output === undefined) throw new Error("无法检查插件仓库来源。");
  return output.split("\0").filter(Boolean).map((entry) => entry.slice(entry.indexOf("\n") + 1));
}

async function installedMetadata(git: LocalGit, name: string, directory: string) {
  const manifest = join(directory, "package.json");
  let source: string | undefined;
  try {
    const info = await lstat(manifest);
    if (!info.isFile() || info.size > 512 * 1024) throw new Error("插件清单无效。");
    source = await Bun.file(manifest).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
  return inspectPluginMetadata(name, source, await repositories(git, directory));
}

function candidateEntries(files: Map<string, TreeEntry>, declaredEntry?: string): string[] {
  if (declaredEntry !== undefined) {
    const path = posix.normalize(declaredEntry);
    if (posix.isAbsolute(path) || path === ".." || path.startsWith("../") ||
        !pluginScriptExtensions.has(posix.extname(path))) return [];
    return [path];
  }
  if (files.has("index.js")) return ["index.js"];
  return [...files.keys()].filter((path) =>
    /^(?:apps\/)?[^./][^/]*\.js$/u.test(path) && path !== "guoba.support.js" && isRegularFile(files.get(path)));
}

export async function pluginCandidateMetadata(
  git: LocalGit, name: string, directory: string, files: Map<string, TreeEntry>, signal?: AbortSignal,
) {
  const manifest = files.get("package.json");
  if (manifest && !isRegularFile(manifest)) return;
  const source = manifest && await git(directory, ["cat-file", "blob", manifest.revision]);
  if (manifest && source === undefined) return;
  const metadata = inspectPluginMetadata(name, source, await repositories(git, directory));
  if (metadata.rejection) return;
  const entries = candidateEntries(files, metadata.entry);
  if (!entries.length) return;
  for (const path of entries) {
    signal?.throwIfAborted();
    const file = files.get(path);
    if (!isRegularFile(file)) return;
    const script = await git(directory, ["cat-file", "blob", file.revision]);
    if (script === undefined || retiredPluginScript(Buffer.from(script))) return;
  }
  return metadata;
}

async function inspectCandidate(
  directory: string, result: Candidate, name?: string, signal?: AbortSignal, force = false,
): Promise<BlockedUpdate | { status: "ready"; update: ReadyUpdate; identities: readonly string[] }> {
  const git = createLocalGit();
  if (!git) return { status: "unavailable" };
  const { current, candidate, binding, release } = result;
  const [files, diff] = await Promise.all([
    readTree(git, directory, candidate),
    git(directory, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
      "--ignore-submodules=none", current, candidate, "--"]),
  ]);
  signal?.throwIfAborted();
  if (!files || diff === undefined) return { status: "unavailable" };
  const metadata = name === undefined ? undefined : await pluginCandidateMetadata(git, name, directory, files, signal);
  signal?.throwIfAborted();
  if (name !== undefined && !metadata) return { status: "rejected" };
  const gitlinks = [...files].flatMap(([path, entry]) => entry.mode === "160000" ? [{ path, revision: entry.revision }] : []);
  return {
    status: "ready", identities: metadata?.identities ?? [],
    update: { status: "ready", scope: name === undefined ? "host" : "plugin", name: name ?? "Lotus-Yunzai",
      ...(force ? { force } : {}), ...((name === undefined || force) && binding ? { binding } : {}),
      directory, current, candidate, changedPaths: diff.split("\0").filter(Boolean), gitlinks, release },
  };
}

export async function installedIdentities(host: string, name: string, plugin: { path: string; packageName: string }) {
  const git = createLocalGit();
  if (!git) throw new Error("无法检查插件仓库来源。");
  const path = await loadedPluginPath(host, { ...plugin, name });
  const metadata = path && await installedMetadata(git, name, path);
  return [`name:${plugin.packageName}`, ...(metadata ? metadata.identities : [])];
}

export async function prepareUpdate(
  root: URL, directories: PluginDirectories, requested?: string, signal?: AbortSignal, force = false,
): Promise<UpdatePreflight> {
  signal?.throwIfAborted();
  let release: (() => Promise<void>) | undefined;
  let ready = false;
  try {
    const host = await realpath(fileURLToPath(root));
    const query = requested?.trim();
    const plugin = query ? findLoadedPlugin(directories, query) : undefined;
    const path = plugin && await loadedPluginPath(host, plugin);
    signal?.throwIfAborted();
    if (query && (!plugin || !path)) return { status: "unavailable" };
    const external = plugin && !builtIns.has(plugin.name) ? plugin : undefined;
    const directory = external && path ? path : host;
    const result = await fetchUpdateCandidate(directory, signal, force);
    if ("release" in result) release = result.release;
    signal?.throwIfAborted();
    if (!("release" in result)) return { status: result.status };
    if (result.status !== "ready") return { status: result.status };
    const inspected = await inspectCandidate(directory, result, external?.name, signal, force);
    if (inspected.status !== "ready") return inspected;
    if (external) {
      const identities = new Set(inspected.identities);
      for (const [name, plugin] of directories) {
        signal?.throwIfAborted();
        if (name !== external.name && (await installedIdentities(host, name, plugin)).some((id) => identities.has(id))) {
          return { status: "rejected" };
        }
      }
    }
    signal?.throwIfAborted();
    ready = true;
    return inspected.update;
  } catch {
    signal?.throwIfAborted();
    return { status: "unavailable" };
  } finally {
    if (!ready) await release?.().catch(() => {});
  }
}

export async function trackedPluginNames(directory: string, revision: string) {
  const git = createLocalGit();
  const listing = await git?.(directory, ["ls-tree", "-z", "--name-only", `${revision}:plugins`]);
  if (listing !== undefined) return new Set(listing.split("\0").filter(Boolean));
  const entry = await git?.(directory, ["ls-tree", "-z", "--name-only", revision, "--", "plugins"]);
  if (entry === "") return new Set<string>();
  throw new Error("无法检查宿主跟踪的插件目录。");
}

async function externalBinding(directory: string) {
  try {
    await lstat(join(directory, ".git"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "unbound";
    throw error;
  }
  const git = createLocalGit();
  if (!git || !await isGitCheckout(git, directory)) return "unavailable";
  const binding = await updateUpstreamBinding(git, directory);
  if (binding !== "unbound") return binding;
  const dirty = await isUpdateWorktreeDirty(git, directory);
  return dirty === undefined ? "unavailable" : dirty ? "dirty" : "unbound";
}

export async function prepareAllUpdates(
  root: URL, directories: PluginDirectories, signal?: AbortSignal, force = false,
): Promise<ReadyBatchUpdate | BlockedUpdate> {
  const releases = new Set<() => Promise<void>>();
  const release = async () => {
    const outcomes = await Promise.allSettled([...releases].map(async (drop) => {
      await drop();
      releases.delete(drop);
    }));
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed) throw failed.reason;
  };
  let ready = false;
  let target = "Lotus-Yunzai";
  try {
    signal?.throwIfAborted();
    const directory = await realpath(fileURLToPath(root));
    const result = await fetchUpdateCandidate(directory, signal, force);
    if ("release" in result) releases.add(result.release);
    signal?.throwIfAborted();
    if (!("release" in result)) return { status: result.status, target };
    if (result.status === "diverged") return { status: "diverged", target };

    const { current } = result;
    const selected = result.status === "ready";
    const candidate = selected ? result.candidate : current;
    const tracked = await trackedPluginNames(directory, current);
    const plugins = new Map<string, ReadyUpdate>();
    const candidateIdentities = new Map<string, readonly string[]>();
    for (const [name, plugin] of directories) {
      signal?.throwIfAborted();
      if (builtIns.has(name) || tracked.has(name)) continue;
      target = name;
      const path = await loadedPluginPath(directory, { ...plugin, name });
      if (!path) return { status: "unavailable", target };
      const binding = await externalBinding(path);
      signal?.throwIfAborted();
      if (binding === "unbound") continue;
      if (binding !== "bound") return { status: binding, target };
      const result = await fetchUpdateCandidate(path, signal, force);
      if ("release" in result) releases.add(result.release);
      signal?.throwIfAborted();
      if (!("release" in result)) return { status: result.status, target };
      if (result.status === "diverged") return { status: "diverged", target };
      if (result.status !== "ready") continue;
      const inspected = await inspectCandidate(path, result, name, signal, force);
      if (inspected.status !== "ready") return { status: inspected.status, target };
      plugins.set(name, inspected.update);
      candidateIdentities.set(name, inspected.identities);
    }

    signal?.throwIfAborted();
    if (!selected && !plugins.size) return { status: "current" };
    if (plugins.size) {
      const peers = new Set<string>();
      for (const [name, plugin] of directories) {
        signal?.throwIfAborted();
        if (plugins.has(name)) continue;
        target = name;
        for (const identity of await installedIdentities(directory, name, plugin)) peers.add(identity);
      }
      for (const [name, identities] of candidateIdentities) {
        if (identities.some((id) => peers.has(id))) return { status: "rejected", target: name };
        for (const id of identities) peers.add(id);
      }
    }
    signal?.throwIfAborted();
    ready = true;
    return {
      status: "ready", scope: "all", ...(force ? { force } : {}),
      host: { directory, current, candidate, ...(force && selected ? { force } : {}),
        ...(selected && result.binding ? { binding: result.binding } : {}) }, plugins, release,
    };
  } catch {
    signal?.throwIfAborted();
    return { status: "unavailable", target };
  } finally {
    if (!ready) await release().catch(() => {});
  }
}
