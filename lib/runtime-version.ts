import { lstat, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtInDirectories } from "./builtin-modules.ts";

export interface RuntimeVersion {
  readonly version?: string;
  readonly revision?: string;
  readonly modified?: boolean;
  readonly modules: readonly { readonly name: string; readonly revision: string }[];
}

type Git = (directory: string, args: string[], allowEmpty?: boolean) => Promise<string | undefined>;
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const fullSha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

async function manifestVersion(root: URL): Promise<string | undefined> {
  try {
    const file = Bun.file(new URL("package.json", root));
    if (!await file.exists()) return;
    const manifest: unknown = await file.json();
    if (typeof manifest !== "object" || manifest === null || !("version" in manifest) ||
        typeof manifest.version !== "string") return;
    const parsed = semver.exec(manifest.version);
    if (parsed?.[0] === manifest.version && !parsed[1]?.split(".").some((part) => /^0\d+$/u.test(part))) return manifest.version;
  } catch {
    return;
  }
}

function createGit(binary: string): Git {
  const signal = AbortSignal.timeout(1_500);
  return async (directory, args, allowEmpty = false) => {
    try {
      const task = Bun.spawn([binary, "--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, ...args], {
        cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "ignore", signal,
        killSignal: "SIGKILL", maxBuffer: 512 * 1024,
        env: {
          PATH: process.env.PATH, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: devNull,
        },
      });
      const [output, exit] = await Promise.all([new Response(task.stdout).text(), task.exited]);
      if (exit === 0 || (exit === 1 && allowEmpty)) return output;
    } catch {
      return;
    }
  };
}

async function checkout(git: Git, directory: string): Promise<boolean> {
  const marker = join(directory, ".git");
  try {
    const info = await lstat(marker);
    if (!info.isDirectory() && !info.isFile()) return false;
    const paths = (await git(directory, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]))?.trimEnd().split("\n");
    if (paths?.length !== 2 || await realpath(paths[0]!) !== directory) return false;
    const gitDirectory = await realpath(paths[1]!);
    if (info.isDirectory()) return gitDirectory === marker;

    // Git reports a copied worktree .git pointer as a distinct top-level directory.
    const backlink = Bun.file(join(gitDirectory, "gitdir"));
    if (await backlink.exists()) return await realpath(resolve(gitDirectory, (await backlink.text()).trimEnd())) === marker;
    const worktree = (await git(directory, ["config", "--local", "--no-includes", "--get", "core.worktree"]))?.trimEnd();
    return !!worktree && await realpath(resolve(gitDirectory, worktree)) === directory;
  } catch {
    return false;
  }
}

async function gitRevision(git: Git, directory: string): Promise<string | undefined> {
  const sha = (await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"]))?.trim();
  return sha && fullSha.test(sha) ? sha : undefined;
}

async function gitModified(git: Git, directory: string): Promise<boolean | undefined> {
  const configured = await git(directory, ["config", "--name-only", "--null", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"], true);
  if (configured === undefined) return;
  const filters = new Set(configured.split("\0").map((key) => /^filter\.(.+)\.(?:clean|process|required)$/u.exec(key)?.[1]).filter(Boolean));
  const disableFilters = [...filters].flatMap((name) => [
    "-c", `filter.${name}.clean=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`,
  ]);
  const response = await git(directory, [...disableFilters, "status", "--porcelain", "--untracked-files=no", "--ignore-submodules=dirty"]);
  return response === undefined ? undefined : response.length > 0;
}

async function installedModules(git: Git, directory: string) {
  const known = new Set(builtInDirectories.values());
  const tracked = await git(directory, ["ls-files", "--stage", "-z", "--", ...[...known].map((name) => `plugins/${name}`)]);
  if (tracked === undefined) return;
  const names = tracked.split("\0").flatMap((entry) => {
    const match = /^160000 [0-9a-f]+ 0\tplugins\/([a-z0-9-]+)$/u.exec(entry);
    return match?.[1] && known.has(match[1]) ? [match[1]] : [];
  });
  const modules = await Promise.all(names.sort().map(async (name) => {
    const path = join(directory, "plugins", name);
    try {
      if (await realpath(path) !== path || !await checkout(git, path)) return;
      const [revision, modified] = await Promise.all([gitRevision(git, path), gitModified(git, path)]);
      if (revision) return { name, revision, modified };
    } catch {
      return;
    }
  }));
  return modules.filter((module) => module !== undefined);
}

export async function readRuntimeVersion(root: URL): Promise<RuntimeVersion> {
  const version = await manifestVersion(root);
  const fallback: RuntimeVersion = { ...(version ? { version } : {}), modules: [] };
  const binary = Bun.which("git");
  if (!binary) return fallback;
  try {
    const directory = await realpath(fileURLToPath(root));
    const git = createGit(binary);
    if (!await checkout(git, directory)) return fallback;
    const [revision, modified, installed] = await Promise.all([
      gitRevision(git, directory), gitModified(git, directory), installedModules(git, directory),
    ]);
    const modules = installed?.map(({ name, revision }) => ({ name, revision })) ?? [];
    const changed = modified === true || installed?.some((entry) => entry.modified === true) ? true
      : modified === false && installed?.every((entry) => entry.modified === false) ? false : undefined;
    return { ...fallback, ...(revision ? { revision } : {}), ...(changed !== undefined ? { modified: changed } : {}), modules };
  } catch {
    return fallback;
  }
}
