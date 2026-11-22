import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lockFile } from "../file-lock.ts";
import { isManagedPluginDirectory } from "../managed-update-protocol.ts";
import { checkRetainedHostDependency, legacyDependencyName, resolveLegacySpecifier,
  type LegacyImportMode, type LegacyUnresolvedDependency } from "./legacy-dependency-resolution.ts";
import { copyLocalPlugin } from "./local-plugin-copy.ts";
import { type ApprovedProtocolReplacement } from "./legacy-protocol-replacements.ts";
import { planMigration, withinInstallation, type LegacyMigrationPlan } from "./migration-plan.ts";

const browserPackages = new Set([
  "puppeteer", "puppeteer-core", "puppeteer-extra", "playwright", "playwright-core", "playwright-chromium",
  "playwright-firefox", "playwright-webkit", "chromium", "chromium-binary", "chrome-launcher",
  "chrome-remote-interface", "selenium-webdriver", "webdriverio", "phantomjs", "phantomjs-prebuilt",
  "@sparticuz/chromium", "@sparticuz/chromium-min",
]);
const javascript = new Bun.Transpiler({ loader: "js" });
const typescript = new Bun.Transpiler({ loader: "ts" });
const scanners = new Map([
  [".js", javascript], [".mjs", javascript], [".cjs", javascript],
  [".ts", typescript], [".mts", typescript], [".cts", typescript],
  [".jsx", new Bun.Transpiler({ loader: "jsx" })], [".tsx", new Bun.Transpiler({ loader: "tsx" })],
]);
const runtimeDependencies = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

interface RetainedInspection {
  readonly dependencies: readonly string[];
  readonly browser: readonly string[];
  readonly issues: readonly DependencyIssue[];
  readonly entry?: string;
}

interface StaticDependency {
  readonly source: string;
  readonly specifier: string;
  readonly mode: LegacyImportMode | "manifest";
}

interface DependencyIssue extends StaticDependency {
  readonly reason: LegacyUnresolvedDependency | "missing-relative-module" | "outside-installation";
}

type DependencyManifest = ReadonlyMap<string, { readonly range: string; readonly required: boolean }>;

async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function browserName(specifier: string) {
  const name = /^(?:@[\w.-]+\/)?[\w.-]+/u.exec(specifier.replace(/^npm:/u, ""))?.[0];
  if (name && (browserPackages.has(name) || name.startsWith("@playwright/") ||
      name.startsWith("@puppeteer/") || name.startsWith("puppeteer-extra-plugin-"))) return name;
}

function fromManifest(manifests: ReadonlyMap<string, DependencyManifest>, root: string, file: string) {
  for (let directory = dirname(file); withinInstallation(root, directory); directory = dirname(directory)) {
    const manifest = manifests.get(directory);
    if (manifest) return { directory, manifest };
    if (directory === root) break;
  }
}

async function resolveLocalDependency(
  specifier: string, from: string, mode: LegacyImportMode, allowedRoot: string,
): Promise<DependencyIssue["reason"] | undefined> {
  let resolved: string;
  try {
    resolved = resolveLegacySpecifier(specifier, from, mode);
  } catch {
    return "missing-relative-module";
  }
  if (!isAbsolute(resolved) || !withinInstallation(allowedRoot, resolved)) return "outside-installation";
  try {
    const file = await realpath(resolved);
    if (!withinInstallation(allowedRoot, file)) return "outside-installation";
    if (!(await lstat(file)).isFile()) return "missing-relative-module";
  } catch {
    return "missing-relative-module";
  }
}

async function inspectStagedPlugin(
  root: string, target: string, finalRoot: string, signal?: AbortSignal,
): Promise<RetainedInspection> {
  const dependencies = new Set<string>();
  const browser = new Set<string>();
  const imports: StaticDependency[] = [];
  const issues: DependencyIssue[] = [];
  const manifests = new Map<string, DependencyManifest>();
  const isDirectory = (await lstat(root)).isDirectory();
  const localRoot = isDirectory ? root : dirname(root);
  const targetRoot = isDirectory ? finalRoot : dirname(finalRoot);
  let entry: string | undefined;
  const files = [root];
  while (files.length) {
    signal?.throwIfAborted();
    const path = files.pop()!;
    const info = await lstat(path);
    const scanner = scanners.get(extname(path));
    if (info.isDirectory()) {
      for (const name of await readdir(path)) files.push(join(path, name));
    } else if (info.isFile() && basename(path) === "package.json") {
      if (info.size > 256 * 1024) throw new Error("迁移插件清单超过预检大小上限。");
      const manifest = record(JSON.parse((await Bun.file(path).text()).replace(/^\uFEFF/u, "")));
      if (path === join(root, "package.json")) {
        const declared = record(manifest.lotusYunzai).entry;
        if (typeof declared === "string") entry = declared.replace(/^(?:\.\/)+/u, "");
      }
      const manifestDeps = new Map<string, { range: string; required: boolean }>();
      for (const field of runtimeDependencies) {
        for (const [name, version] of Object.entries(record(manifest[field]))) {
          const pkg = browserName(name) || (typeof version === "string" && version.startsWith("npm:") ? browserName(version) : undefined);
          if (pkg) browser.add(pkg);
          if (legacyDependencyName(name) !== name) continue;
          dependencies.add(name);
          const optionalPeer = field === "peerDependencies" &&
            record(record(manifest.peerDependenciesMeta)[name]).optional === true;
          if (field === "peerDependencies" && manifestDeps.has(name)) continue;
          manifestDeps.set(name, {
            range: typeof version === "string" ? version : "",
            required: field !== "optionalDependencies" && !optionalPeer,
          });
        }
      }
      manifests.set(dirname(path), manifestDeps);
    } else if (info.isFile() && scanner) {
      if (info.size > 8 * 1024 * 1024) throw new Error("迁移插件脚本超过预检大小上限。");
      for (const { path: specifier, kind } of scanner.scanImports(await Bun.file(path).text())) {
        const pkg = browserName(specifier);
        if (pkg) browser.add(pkg);
        imports.push({ source: relative(localRoot, path), specifier, mode: kind === "require-call" ? "require" : "import" });
      }
    }
    // The copied tree's links can only reference an included ordinary file.
    // Inspect just that file's own path, without following a second spelling.
  }
  const used = new Map<string, Set<string>>();
  for (const request of imports) {
    signal?.throwIfAborted();
    const { source, specifier } = request;
    const mode: LegacyImportMode = request.mode === "require" ? "require" : "import";
    const importer = dirname(join(localRoot, source));
    const finalImporter = dirname(join(targetRoot, source));
    if (/^\.{1,2}(?:\/|$)/u.test(specifier) || specifier.startsWith("#")) {
      const lexicalPath = resolve(importer, specifier);
      let reason: DependencyIssue["reason"] | undefined;
      if ((isDirectory && withinInstallation(root, lexicalPath)) || specifier.startsWith("#")) {
        reason = await resolveLocalDependency(specifier, importer, mode, root);
      } else if (!withinInstallation(target, resolve(finalImporter, specifier))) {
        reason = "outside-installation";
      } else {
        reason = await resolveLocalDependency(specifier, finalImporter, mode, target);
      }
      if (reason !== undefined) issues.push({ ...request, reason });
      continue;
    }
    const scheme = /^[a-z][a-z0-9+.-]*:/iu.exec(specifier)?.[0];
    if (isAbsolute(specifier) || (scheme && scheme !== "bun:" && scheme !== "node:")) {
      issues.push({ ...request, specifier: "<external-path>", reason: "outside-installation" });
      continue;
    }
    const name = legacyDependencyName(specifier);
    const declared = fromManifest(manifests, root, join(localRoot, source));
    if (name && declared?.manifest.has(name)) {
      const names = used.get(declared.directory) ?? new Set();
      names.add(name);
      used.set(declared.directory, names);
    }
    const range = name && declared ? declared.manifest.get(name)?.range : undefined;
    const result = await checkRetainedHostDependency(target, finalImporter, specifier, range, mode);
    if (result.status === "unverified") issues.push({ ...request,
      specifier: result.reason === "unsupported-specifier" ? "<unsupported-import>" : specifier, reason: result.reason });
  }
  for (const [directory, manifest] of manifests) {
    const finalImporter = join(targetRoot, relative(localRoot, directory));
    for (const [specifier, { range, required }] of manifest) {
      signal?.throwIfAborted();
      if (!required || used.get(directory)?.has(specifier)) continue;
      const result = await checkRetainedHostDependency(target, finalImporter, specifier, range);
      if (result.status === "unverified") {
        issues.push({ source: relative(localRoot, join(directory, "package.json")), specifier,
          mode: "manifest", reason: result.reason });
      }
    }
  }
  return { dependencies: [...dependencies].sort(), browser: [...browser].sort(), issues, entry };
}

type RetainedPlugin = { readonly path: string; readonly dependencies: readonly string[] };
type HeldPlugin = { readonly path: string } & (
  { readonly reason: "browser-dependency"; readonly dependencies: readonly string[] } |
  { readonly reason: "unresolved-dependency"; readonly issues: readonly DependencyIssue[] } |
  { readonly reason: "inspection-failed" } |
  { readonly reason: "retired-entry" });

/** Populate an isolated overlay. Only the later migration publisher may install it. */
export async function stageRetainedLegacyPlugins(plan: LegacyMigrationPlan, stagingPath: string, signal?: AbortSignal,
  approvals?: readonly ApprovedProtocolReplacement[]) {
  signal?.throwIfAborted();
  const staging = await realpath(stagingPath);
  const stagingInfo = await lstat(staging);
  if (!stagingInfo.isDirectory()) throw new Error("兼容插件暂存根须为实体目录。");
  for (const path of [plan.source, plan.target]) {
    const canonical = await realpath(path);
    const info = await lstat(canonical);
    if (withinInstallation(canonical, staging) || withinInstallation(staging, canonical) ||
        (info.dev === stagingInfo.dev && info.ino === stagingInfo.ino)) throw new Error("兼容插件暂存根须与新旧安装独立。");
  }

  const retained: RetainedPlugin[] = [];
  const held: HeldPlugin[] = [];
  const destination = join(staging, "plugins");
  const heldDestination = join(staging, "held-plugins");
  const lock = await lockFile(join(dirname(staging), `.${basename(staging)}.lotus-plugin-retain.sqlite`), "迁移兼容插件");
  let temporary: string | undefined;
  try {
    const confirmPlan = async () => {
      signal?.throwIfAborted();
      if (!isDeepStrictEqual(plan, await planMigration(plan.source, plan.target, approvals))) {
        throw new Error("旧插件或目标工作区已变化，请重新预检。");
      }
    };
    await confirmPlan();
    const targetRoot = await optionalStat(join(plan.target, "plugins"));
    if (targetRoot && !targetRoot.isDirectory()) throw new Error("目标插件根须为实体目录。");
    const confirmDestinations = async () => {
      if (await optionalStat(destination) || await optionalStat(heldDestination)) throw new Error("兼容插件暂存目录已存在。");
    };
    await confirmDestinations();

    temporary = await mkdtemp(join(staging, ".lotus-retained-"));
    const stagedPlugins = join(temporary, "plugins");
    const stagedHeld = join(temporary, "held-plugins");
    await mkdir(stagedPlugins, { mode: 0o700 });
    await mkdir(stagedHeld, { mode: 0o700 });
    for (const entry of plan.plugins) {
      if (entry.status !== "retain") continue;
      signal?.throwIfAborted();
      const [prefix, name, ...rest] = entry.path.split("/");
      if (prefix !== "plugins" || !isManagedPluginDirectory(name) || rest.length) throw new Error("兼容插件路径无效。");
      if (await optionalStat(join(plan.target, entry.path))) throw new Error(`目标已有插件路径 ${entry.path}。`);
      const exclude = new Set(plan.plugins.flatMap(archived =>
        archived.status === "archive" && archived.kind === "script" && archived.path.startsWith(entry.path + "/")
          ? [archived.path.slice(entry.path.length + 1)] : []));
      const output = join(stagedPlugins, name);
      await copyLocalPlugin(join(plan.source, entry.path), output, signal, { exclude, rejectSpecialPermissions: true });
      let inspection: RetainedInspection | undefined;
      try {
        inspection = await inspectStagedPlugin(output, plan.target, join(plan.target, entry.path), signal);
      } catch {
        signal?.throwIfAborted();
      }
      if (!inspection) {
        held.push({ path: entry.path, reason: "inspection-failed" });
      } else if (exclude.has(inspection.entry ?? "index.js")) {
        held.push({ path: entry.path, reason: "retired-entry" });
      } else if (inspection.browser.length) {
        held.push({ path: entry.path, reason: "browser-dependency", dependencies: inspection.browser });
      } else if (inspection.issues.length) {
        held.push({ path: entry.path, reason: "unresolved-dependency", issues: inspection.issues });
      } else {
        retained.push({ path: entry.path, dependencies: inspection.dependencies });
        continue;
      }
      await rename(output, join(stagedHeld, name));
    }
    await confirmPlan();
    await confirmDestinations();
    const heldDirectory = held.length ? heldDestination : undefined;
    if (heldDirectory) await rename(stagedHeld, heldDirectory);
    if (!retained.length) return { status: "empty", retained, held, heldDirectory } as const;
    try {
      await rename(stagedPlugins, destination);
    } catch (error) {
      if (heldDirectory) await rename(heldDirectory, stagedHeld);
      throw error;
    }
    return { status: "published", directory: destination, retained, held, heldDirectory } as const;
  } finally {
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } finally {
      lock.close();
    }
  }
}
