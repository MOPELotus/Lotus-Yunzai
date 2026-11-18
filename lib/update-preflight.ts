import { lstat, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { builtInDirectories } from "./builtin-modules.ts";
import { createLocalGit, isGitCheckout, type LocalGit } from "./local-git.ts";
import { findLoadedPlugin, loadedPluginPath, type PluginDirectories } from "./plugins/loaded-directories.ts";
import { inspectPluginMetadata, pluginScriptExtensions, retiredPluginScript } from "./plugins/metadata.ts";
import { fetchUpdateCandidate } from "./update-candidate-git.ts";

interface TreeEntry {
  readonly mode: string;
  readonly revision: string;
}

export interface ReadyUpdate {
  readonly status: "ready";
  readonly scope: "host" | "plugin";
  readonly name: string;
  readonly directory: string;
  readonly current: string;
  readonly candidate: string;
  readonly changedPaths: readonly string[];
  readonly gitlinks: readonly { path: string; revision: string }[];
  readonly release: () => Promise<void>;
}

type UpdatePreflight = ReadyUpdate | {
  readonly status: "current" | "ahead" | "diverged" | "dirty" | "unavailable" | "rejected";
};

const builtIns = new Set(builtInDirectories.values());

async function readTree(git: LocalGit, directory: string, revision: string) {
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

async function allowedPluginCandidate(
  git: LocalGit, host: string, directories: PluginDirectories, name: string, directory: string, files: Map<string, TreeEntry>,
  signal?: AbortSignal,
): Promise<boolean> {
  const manifest = files.get("package.json");
  if (manifest && !isRegularFile(manifest)) return false;
  const source = manifest && await git(directory, ["cat-file", "blob", manifest.revision]);
  if (manifest && source === undefined) return false;
  const metadata = inspectPluginMetadata(name, source, await repositories(git, directory));
  if (metadata.rejection) return false;
  const identities = new Set(metadata.identities);
  for (const [otherName, other] of directories) {
    signal?.throwIfAborted();
    if (otherName === name) continue;
    if (metadata.name === other.packageName) return false;
    const path = await loadedPluginPath(host, { ...other, name: otherName });
    if (path && (await installedMetadata(git, otherName, path)).identities.some((id) => identities.has(id))) return false;
  }
  const entries = candidateEntries(files, metadata.entry);
  if (!entries.length) return false;
  for (const path of entries) {
    signal?.throwIfAborted();
    const file = files.get(path);
    if (!isRegularFile(file)) return false;
    const script = await git(directory, ["cat-file", "blob", file.revision]);
    if (script === undefined || retiredPluginScript(Buffer.from(script))) return false;
  }
  return true;
}

export async function prepareUpdate(
  root: URL, directories: PluginDirectories, requested?: string, signal?: AbortSignal,
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
    const result = await fetchUpdateCandidate(directory, signal);
    if ("release" in result) release = result.release;
    signal?.throwIfAborted();
    if (!("release" in result)) return { status: result.status };
    if (result.status !== "ready") return { status: result.status };
    const git = createLocalGit();
    if (!git) return { status: "unavailable" };
    const { current, candidate } = result;
    const files = await readTree(git, directory, candidate);
    signal?.throwIfAborted();
    const diff = await git(directory, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
      "--ignore-submodules=none", current, candidate, "--"]);
    signal?.throwIfAborted();
    if (!files || diff === undefined) return { status: "unavailable" };
    const accepted = !external ||
      await allowedPluginCandidate(git, host, directories, external.name, directory, files, signal);
    signal?.throwIfAborted();
    if (!accepted) return { status: "rejected" };
    const gitlinks = [...files].flatMap(([path, entry]) => entry.mode === "160000" ? [{ path, revision: entry.revision }] : []);
    ready = true;
    return { status: "ready", scope: external ? "plugin" : "host", name: external?.name ?? "Lotus-Yunzai",
      directory, current, candidate, changedPaths: diff.split("\0").filter(Boolean), gitlinks, release: result.release };
  } catch {
    signal?.throwIfAborted();
    return { status: "unavailable" };
  } finally {
    if (!ready) await release?.().catch(() => {});
  }
}
