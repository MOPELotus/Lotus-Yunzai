import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const barePackage = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:\/[^\\?#\x00-\x20]+)?$/iu;
const semverPart = "(?:[0-9]+|[xX*])";
const semverAtom = `[vV]?${semverPart}(?:\\.${semverPart}){0,2}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`;
const semverComparator = `(?:<=|>=|<|>|=|~|\\^)? *${semverAtom}`;
const semverInterval = `(?:${semverAtom} +-[ ]+${semverAtom}|${semverComparator}(?: +${semverComparator})*)`;
const semverRange = new RegExp(`^${semverInterval}(?: *\\|\\| *${semverInterval})*$`, "u");
const exactVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export type LegacyImportMode = "import" | "require";
export type LegacyUnresolvedDependency = "unsupported-specifier" | "missing" | "runtime-alias" | "outside-host" | "version";

type HostDependency = {
  readonly status: "host";
  readonly version: string;
} | { readonly status: "runtime" } | {
  readonly status: "unverified";
  readonly reason: LegacyUnresolvedDependency;
};

export function legacyDependencyName(specifier: string) {
  return barePackage.exec(specifier)?.[1];
}

export function resolveLegacySpecifier(specifier: string, from: string, mode: LegacyImportMode) {
  return mode === "require"
    ? createRequire(join(from, "index.cjs")).resolve(specifier)
    : Bun.resolveSync(specifier, from);
}

function isInside(root: string, path: string): boolean {
  const local = relative(root, path);
  return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}

async function packageVersion(entry: string, base: string, name: string): Promise<string | undefined> {
  for (let directory = dirname(entry); directory !== base && isInside(base, directory); directory = dirname(directory)) {
    const path = join(directory, "package.json");
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 256 * 1024) return;
      const manifest: unknown = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/u, ""));
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return;
      if ("name" in manifest && manifest.name !== name) return;
      if ("name" in manifest && "version" in manifest && typeof manifest.version === "string" &&
          exactVersion.test(manifest.version)) return manifest.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
  }
}

/** Check a statically observed import from its final directory without evaluating the module. */
export async function checkRetainedHostDependency(
  targetRoot: string, finalImporterDirectory: string, specifier: string, declaredRange?: string, mode: LegacyImportMode = "import",
): Promise<HostDependency> {
  const target = await realpath(targetRoot);
  const pluginRoot = join(target, "plugins");
  if (!isAbsolute(finalImporterDirectory) || !isInside(pluginRoot, finalImporterDirectory)) {
    throw new Error("外部插件依赖检查须使用目标插件内的绝对路径。");
  }

  if (isBuiltin(specifier) && declaredRange === undefined) return { status: "runtime" };
  const name = legacyDependencyName(specifier);
  if (!name && !specifier.startsWith("bun:")) return { status: "unverified", reason: "unsupported-specifier" };
  if (specifier.split("/").some(part => part === "." || part === "..")) {
    return { status: "unverified", reason: "unsupported-specifier" };
  }

  let resolved: string;
  try {
    resolved = resolveLegacySpecifier(specifier, finalImporterDirectory, mode);
  } catch {
    return { status: "unverified", reason: "missing" };
  }
  if (!isAbsolute(resolved)) {
    const runtime = specifier === "bun" || specifier.startsWith("bun:") ||
      (mode === "import" && specifier === "node-fetch" && resolved === specifier);
    return runtime && declaredRange === undefined ? { status: "runtime" } : { status: "unverified", reason: "runtime-alias" };
  }
  let entry: string;
  try {
    entry = await realpath(resolved);
  } catch {
    return { status: "unverified", reason: "missing" };
  }
  if (!isInside(target, entry)) return { status: "unverified", reason: "outside-host" };
  const version = name && await packageVersion(entry, target, name);
  if (!version || (declaredRange !== undefined &&
      (declaredRange.length > 256 || !semverRange.test(declaredRange.trim()) ||
        !Bun.semver.satisfies(version, declaredRange)))) {
    return { status: "unverified", reason: "version" };
  }
  return { status: "host", version };
}
