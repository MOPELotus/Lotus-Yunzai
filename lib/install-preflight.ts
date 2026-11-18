import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { builtInDirectories } from "./builtin-modules.ts";
import { installRejection, normalizeApprovedInstall, type ApprovedInstall } from "./install-catalog.ts";
import { createLocalGit, gitHead, isGitCheckout, isGitRevision } from "./local-git.ts";
import type { PluginDirectories } from "./plugins/loaded-directories.ts";
import { runUpdateProcess } from "./update-build.ts";
import { installedIdentities, pluginCandidateMetadata, readTree, trackedPluginNames } from "./update-preflight.ts";

export interface ReadyInstall {
  readonly status: "ready";
  readonly scope: "install";
  readonly approval: ApprovedInstall;
  readonly host: { readonly directory: string; readonly current: string };
  readonly plugin: { readonly name: string; readonly source: string; readonly revision: string };
  readonly release: () => Promise<void>;
}

type InstallPreflight = ReadyInstall | { readonly status: "exists" | "rejected" | "unavailable" };

const builtIns = new Set(builtInDirectories.values());
const stateDirectories = new Set(["config", "data", "logs"]);
const worktreePaths = new Set([".git", "node_modules"]);

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
}

function conflictsWithWorktree(path: string, mode: string): boolean {
  const pieces = path.toLowerCase().split("/");
  const [root] = pieces;
  return mode === "160000" || pieces.some((part) => worktreePaths.has(part)) ||
    (pieces.length === 1 && (root === ".gitmodules" || root === ".env" || root?.startsWith(".env.") === true ||
      (root !== undefined && stateDirectories.has(root) && mode !== "040000")));
}

async function runInstallGit(binary: string, source: string, args: string[], signal?: AbortSignal): Promise<boolean> {
  return runUpdateProcess(source, {
    PATH: process.env.PATH, LC_ALL: "C", HOME: source, XDG_CONFIG_HOME: source,
    GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "https", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
  }, [binary, "--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`,
    "-c", "credential.helper=", "-c", "core.askPass=", "-c", "http.followRedirects=false",
    "-c", "fetch.writeCommitGraph=false", "-c", "fetch.bundleURI=", "-c", "transfer.bundleURI=false",
    ...args], 45_000, signal);
}

export async function preparePluginInstall(
  root: URL, directories: PluginDirectories, approved: ApprovedInstall, stagingParent: string, signal?: AbortSignal,
): Promise<InstallPreflight> {
  let release: (() => Promise<void>) | undefined;
  let ready = false;
  const unavailable = { status: "unavailable" } as const;
  const rejected = { status: "rejected" } as const;
  const exists = { status: "exists" } as const;
  try {
    signal?.throwIfAborted();
    const entry = normalizeApprovedInstall(approved);
    if (!entry || entry.name !== approved.name || entry.directory !== approved.directory || entry.url !== approved.url ||
        entry.branch !== approved.branch || entry.revision !== approved.revision) return rejected;
    const name = entry.directory;
    if (installRejection(entry.url, entry.name, name)) return rejected;
    if (builtIns.has(name.toLowerCase()) || directories.has(name)) return exists;
    const [host, parent] = await Promise.all([realpath(fileURLToPath(root)), realpath(stagingParent)]);
    const fromHost = relative(host, parent);
    if (!isAbsolute(fromHost) && fromHost !== ".." && !fromHost.startsWith(`..${sep}`)) return unavailable;
    const git = createLocalGit();
    const binary = Bun.which("git");
    if (!git || !binary || !await isGitCheckout(git, host)) return unavailable;
    const mergeRef = `refs/heads/${entry.branch}`;
    if (await git(host, ["check-ref-format", mergeRef]) === undefined) return rejected;
    const pluginRoot = join(host, "plugins");
    const rootInfo = await pathInfo(pluginRoot);
    if (rootInfo && !rootInfo.isDirectory()) return unavailable;
    const destination = join(pluginRoot, name);
    if (await pathInfo(destination)) return exists;
    const current = await gitHead(git, host);
    if (!current) return unavailable;
    if ((await trackedPluginNames(host, current)).has(name)) return exists;

    signal?.throwIfAborted();
    const source = await mkdtemp(join(parent, "lotus-install-"));
    let removing: Promise<void> | undefined;
    release = () => removing ??= rm(source, { recursive: true, force: true }).catch((error: unknown) => {
      removing = undefined;
      throw error;
    });
    const trackingRef = `refs/remotes/origin/${entry.branch}`;
    if (!await runInstallGit(binary, source, ["init", "--quiet", "--template=",
      `--object-format=${entry.revision.length === 64 ? "sha256" : "sha1"}`], signal) ||
        !await runInstallGit(binary, source, ["remote", "add", "--", "origin", entry.url], signal) ||
        !await runInstallGit(binary, source, [
          "fetch", "--atomic", "--quiet", "--no-tags", "--no-prune", "--no-prune-tags",
          "--no-write-fetch-head", "--no-auto-gc", "--no-recurse-submodules", "--refmap=", "--upload-pack=git-upload-pack",
          "--", "origin", `${mergeRef}:${trackingRef}`,
        ], signal)) return unavailable;

    const inspect = createLocalGit();
    if (!inspect) return unavailable;
    const revision = (await inspect(source, ["rev-parse", "--verify", trackingRef]))?.trim();
    if (!revision || !isGitRevision(revision)) return unavailable;
    if (revision !== entry.revision) return rejected;
    if ((await inspect(source, ["cat-file", "-t", revision]))?.trim() !== "commit") return unavailable;
    const files = await readTree(inspect, source, revision);
    if (!files) return unavailable;
    if ([...files].some(([path, file]) => conflictsWithWorktree(path, file.mode))) return rejected;
    const metadata = await pluginCandidateMetadata(inspect, name, source, files, signal).catch(() => undefined);
    signal?.throwIfAborted();
    if (!metadata) return rejected;
    const identities = new Set(metadata.identities);
    for (const [peer, plugin] of directories) {
      signal?.throwIfAborted();
      if ((await installedIdentities(host, peer, plugin)).some((id) => identities.has(id))) return rejected;
    }

    if (!await runInstallGit(binary, source,
      ["checkout", "--quiet", "--no-recurse-submodules", "-b", entry.branch, "--track", trackingRef, "--"], signal)) return unavailable;
    const verify = createLocalGit();
    if (!verify || !await isGitCheckout(verify, source) || await gitHead(verify, source) !== revision) return unavailable;
    if (await pathInfo(destination)) return exists;
    signal?.throwIfAborted();
    ready = true;
    return {
      status: "ready", scope: "install", approval: entry,
      host: { directory: host, current }, plugin: { name, source, revision }, release,
    };
  } catch {
    signal?.throwIfAborted();
    return unavailable;
  } finally {
    if (!ready) await release?.().catch(() => {});
  }
}
