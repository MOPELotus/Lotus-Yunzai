import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtInDirectories } from "./builtin-modules.ts";
import { createLocalGit, gitHead, isGitCheckout, type LocalGit } from "./local-git.ts";

export interface RuntimeVersion {
  readonly version?: string;
  readonly revision?: string;
  readonly modified?: boolean;
  readonly modules: readonly { readonly name: string; readonly revision: string }[];
}

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

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

async function gitModified(git: LocalGit, directory: string): Promise<boolean | undefined> {
  const configured = await git(directory, ["config", "--name-only", "--null", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"], true);
  if (configured === undefined) return;
  const filters = new Set(configured.split("\0").map((key) => /^filter\.(.+)\.(?:clean|process|required)$/u.exec(key)?.[1]).filter(Boolean));
  const disableFilters = [...filters].flatMap((name) => [
    "-c", `filter.${name}.clean=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`,
  ]);
  const response = await git(directory, [...disableFilters, "status", "--porcelain", "--untracked-files=no", "--ignore-submodules=dirty"]);
  return response === undefined ? undefined : response.length > 0;
}

async function installedModules(git: LocalGit, directory: string) {
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
      if (await realpath(path) !== path || !await isGitCheckout(git, path)) return;
      const [revision, modified] = await Promise.all([gitHead(git, path), gitModified(git, path)]);
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
  const git = createLocalGit();
  if (!git) return fallback;
  try {
    const directory = await realpath(fileURLToPath(root));
    if (!await isGitCheckout(git, directory)) return fallback;
    const [revision, modified, installed] = await Promise.all([
      gitHead(git, directory), gitModified(git, directory), installedModules(git, directory),
    ]);
    const modules = installed?.map(({ name, revision }) => ({ name, revision })) ?? [];
    const changed = modified === true || installed?.some((entry) => entry.modified === true) ? true
      : modified === false && installed?.every((entry) => entry.modified === false) ? false : undefined;
    return { ...fallback, ...(revision ? { revision } : {}), ...(changed !== undefined ? { modified: changed } : {}), modules };
  } catch {
    return fallback;
  }
}
