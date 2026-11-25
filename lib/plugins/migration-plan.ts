import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { builtInDirectories } from "../builtin-modules.ts";
import { createLocalGit } from "../local-git.ts";
import { isManagedPluginDirectory } from "../managed-update-protocol.ts";
import { inspectPluginMetadata, legacyHostScriptGroup, pluginScriptExtensions, retiredPluginScript } from "./metadata.ts";

export type LegacyPluginPlanEntry =
  | { readonly path: string; readonly status: "archive"; readonly kind: "directory" | "script"; readonly reason: string; readonly identity: string;
      readonly replacementModule?: string }
  | { readonly path: string; readonly status: "retain" | "built-in" }
  | { readonly path: string; readonly status: "review" | "scan-error"; readonly reason: string }
  | { readonly path: string; readonly status: "protocol-candidate"; readonly protocol: string };

const maximumMetadataBytes = 256 * 1024;
const maximumScriptBytes = 8 * 1024 * 1024;

class PluginScanLimit extends Error {}

const protocolAliases = new Map([
  ["icqq-plugin", "icqq"], ["qqbot-plugin", "qqbot"],
  ["wechat-plugin", "comwechat"], ["comwechat", "comwechat"], ["comwechat-plugin", "comwechat"],
  ["opq-plugin", "opq"], ["opqbot", "opq"], ["opqbot-plugin", "opq"],
  ["gsuidcore", "gsuidcore"], ["gsuidcore-plugin", "gsuidcore"],
  ["telegram-plugin", "telegram"], ["discord-plugin", "discord"], ["kook-plugin", "kook"],
  ["route-plugin", "route"], ["secluded-adapter", "secluded"], ["secluded-plugin", "secluded"],
]);

function protocolCandidate(directory: string, metadata: ReturnType<typeof inspectPluginMetadata>) {
  const packageName = metadata.declaredName.split("/").at(-1) ?? "";
  const names = [packageName, ...metadata.repositoryNames, directory.toLowerCase()];
  return names.map(name => protocolAliases.get(name.replace(/^yunzai-/u, ""))).find(protocol => protocol !== undefined);
}

async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readRegularFile(path: string, maximum: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const first = await file.stat();
    if (!first.isFile()) throw new Error($t("lib.plugins.migration-plan.text_52713b508e"));
    if (first.size > maximum) throw new PluginScanLimit($t("lib.plugins.migration-plan.text_ca0c983d5b"));
    const contents = Buffer.alloc(first.size + 1);
    let position = 0;
    while (position < contents.length) {
      const { bytesRead } = await file.read(contents, position, contents.length - position, position);
      if (bytesRead === 0) break;
      position += bytesRead;
    }
    const last = await file.stat();
    if (position !== first.size || last.size !== first.size || last.mtimeMs !== first.mtimeMs) {
      throw new Error($t("lib.plugins.migration-plan.text_e4298a2bdc"));
    }
    return contents.subarray(0, position);
  } finally {
    await file.close();
  }
}

async function gitRepositories(plugin: string, targetBuiltInName: string | undefined, declaration: ReturnType<typeof inspectPluginMetadata>) {
  const dotGit = join(plugin, ".git");
  const entry = await optionalStat(dotGit);
  if (!entry) return [];
  // A linked checkout can still supply enough local evidence for a built-in or policy decision.
  if (entry.isFile() && (targetBuiltInName === declaration.declaredName ||
    (declaration.declaredName && declaration.rejectionKind === "policy"))) return [];
  // A copied linked worktree does not establish ownership of its external Git metadata.
  if (!entry.isDirectory()) throw new Error($t("lib.plugins.migration-plan.text_460f41b84a"));
  const config = await readRegularFile(join(dotGit, "config"), maximumMetadataBytes);
  const git = Bun.which("git");
  if (!git) throw new Error($t("lib.plugins.migration-plan.text_2fbd76aecc"));
  const child = Bun.spawn([git, "config", "--file", "-", "--no-includes", "-z", "--get-regexp", "^remote\\..*\\.url$"], {
    cwd: plugin, stdin: config, stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(1_500),
    killSignal: "SIGKILL", maxBuffer: maximumMetadataBytes * 2,
    env: { PATH: process.env.PATH, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull },
  });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code === 1) return [];
  if (code !== 0) throw new Error($t("lib.plugins.migration-plan.text_2fbd76aecc"));
  return output.split("\0").filter(Boolean).map(line => line.slice(line.indexOf("\n") + 1));
}

async function entriesAt(path: string): Promise<Dirent[]> {
  const entry = await optionalStat(path);
  if (!entry) return [];
  if (!entry.isDirectory()) throw new Error($t("lib.plugins.migration-plan.text_4d1c107236"));
  return (await readdir(path, { withFileTypes: true })).sort((first, second) => first.name.localeCompare(second.name, "en"));
}

function visibleEntry(entry: Dirent) {
  return !entry.name.startsWith(".") && entry.name !== "node_modules";
}

async function legacyScripts(directory: string) {
  const entries = await entriesAt(directory);
  if (entries.some(entry => entry.name === "index.js")) return ["index.js"];
  const flat = entries.filter(entry => visibleEntry(entry) && entry.name.endsWith(".js") && entry.name !== "guoba.support.js");
  const nested = (await entriesAt(join(directory, "apps"))).filter(entry => visibleEntry(entry) && entry.name.endsWith(".js"));
  return [...flat.map(entry => entry.name), ...nested.map(entry => `apps/${entry.name}`)];
}

async function readScript(directory: string, entry: string) {
  const file = resolve(directory, entry);
  const local = relative(directory, file);
  if (isAbsolute(entry) || !pluginScriptExtensions.has(extname(local)) ||
      local.split(sep).some(part => !isManagedPluginDirectory(part)) || local !== entry.split("/").join(sep)) {
    throw new Error($t("lib.plugins.migration-plan.text_c391327652"));
  }
  let parent = directory;
  for (const part of local.split(sep).slice(0, -1)) {
    parent = join(parent, part);
    if (!(await lstat(parent)).isDirectory()) throw new Error($t("lib.plugins.migration-plan.text_acccbe6e53"));
  }
  return readRegularFile(file, maximumScriptBytes);
}

function scriptPlan(path: string, bytes: Uint8Array): LegacyPluginPlanEntry {
  const retired = retiredPluginScript(bytes);
  return retired
    ? { path, status: "archive", kind: "script", reason: retired.reason, replacementModule: retired.module,
        identity: createHash("sha256").update(bytes).digest("hex") }
    : { path, status: "retain" };
}

async function legacyHostDirectory(source: string, name: string): Promise<LegacyPluginPlanEntry | undefined> {
  const group = legacyHostScriptGroup(name);
  if (!group) return;
  const entries = (await entriesAt(source)).filter(entry => entry.name !== ".git" && entry.name !== "node_modules");
  if (entries.length !== group.scripts.size) return;
  for (const entry of entries) {
    const hash = group.scripts.get(entry.name);
    if (!entry.isFile() || !hash || createHash("sha256").update(await readScript(source, entry.name)).digest("hex") !== hash) return;
  }
  const identity = createHash("sha256").update(JSON.stringify([...group.scripts])).digest("hex");
  return { path: `plugins/${name}`, status: "archive", kind: "directory", reason: group.reason,
    replacementModule: "lotus-yunzai", identity };
}

/**
 * Paths are relative to the installation. The caller supplies paths owned by
 * the target Lotus-Yunzai checkout; a source checkout can also track legacy plugins.
 */
export async function planLegacyPlugins(
  installation: string,
  targetBuiltInPaths: ReadonlySet<string>,
): Promise<readonly LegacyPluginPlanEntry[]> {
  const root = resolve(installation, "plugins");
  const plan: LegacyPluginPlanEntry[] = [];
  const seen = new Map<string, string>();
  const nativeNames = new Map([...builtInDirectories].map(([name, path]) => [path, name]));
  for (const entry of (await entriesAt(root)).filter(visibleEntry)) {
    const path = `plugins/${entry.name}`;
    const source = join(root, entry.name);
    const occupiesTarget = targetBuiltInPaths.has(path);
    if (!isManagedPluginDirectory(entry.name) || entry.isSymbolicLink()) {
      plan.push({ path, status: "review", reason: $t("lib.plugins.migration-plan.text_6d1d30b62c") });
      continue;
    }
    try {
      if (!entry.isDirectory()) {
        if (occupiesTarget) {
          plan.push({ path, status: "review", reason: $t("lib.plugins.migration-plan.text_a7b03f8fe8") });
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
          plan.push(scriptPlan(path, await readRegularFile(source, maximumScriptBytes)));
        }
        continue;
      }
      const manifest = join(source, "package.json");
      const contents = await optionalStat(manifest) ? (await readRegularFile(manifest, maximumMetadataBytes)).toString("utf8") : undefined;
      const declaration = inspectPluginMetadata(entry.name, contents, []);
      const expectedNativeName = occupiesTarget ? nativeNames.get(entry.name) : undefined;
      const repositories = await gitRepositories(source, expectedNativeName, declaration);
      const metadata = repositories.length ? inspectPluginMetadata(entry.name, contents, repositories) : declaration;
      if (metadata.rejectionKind === "policy" && metadata.rejection) {
        const identity = createHash("sha256").update(JSON.stringify([contents, metadata.identities, metadata.repositoryKeys])).digest("hex");
        plan.push({ path, status: "archive", kind: "directory", reason: metadata.rejection, identity });
        continue;
      }
      if (contents === undefined && !repositories.length) {
        const retired = await legacyHostDirectory(source, entry.name);
        if (retired) {
          plan.push(retired);
          continue;
        }
      }
      if (occupiesTarget) {
        plan.push(expectedNativeName === metadata.declaredName
          ? { path, status: "built-in" }
          : { path, status: "review", reason: $t("lib.plugins.migration-plan.text_82d67f5339") });
        continue;
      }
      if (metadata.rejection) {
        plan.push({ path, status: "review", reason: metadata.rejection });
        continue;
      }
      const protocol = protocolCandidate(entry.name, metadata);
      if (protocol) {
        plan.push({ path, status: "protocol-candidate", protocol });
        continue;
      }
      const duplicate = metadata.identities.map(identity => seen.get(identity)).find(label => label !== undefined);
      if (duplicate) {
        plan.push({ path, status: "review", reason: $t("lib.plugins.migration-plan.text_f29e120ee0", { "duplicate": duplicate }) });
        continue;
      }
      const scripts = metadata.entry === undefined ? await legacyScripts(source) : [metadata.entry.replace(/^(?:\.\/)+/u, "")];
      const archive: LegacyPluginPlanEntry[] = [];
      for (const script of scripts) {
        const result = scriptPlan(`${path}/${script}`, await readScript(source, script));
        if (result.status === "archive") archive.push(result);
      }
      for (const identity of metadata.identities) seen.set(identity, path);
      plan.push({ path, status: "retain" }, ...archive);
    } catch (error) {
      const reason = error instanceof PluginScanLimit ? error.message : $t("lib.plugins.migration-plan.text_0e0aac31f5");
      plan.push({ path, status: "scan-error", reason });
    }
  }
  return plan;
}

export function withinInstallation(base: string, path: string) {
  const local = relative(base, path);
  return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}

export async function planMigration(sourcePath: string, targetPath: string) {
  const [source, target] = await Promise.all([realpath(sourcePath), realpath(targetPath)]);
  const [sourceInfo, targetInfo] = await Promise.all([lstat(source), lstat(target)]);
  if (!sourceInfo.isDirectory() || !targetInfo.isDirectory()) throw new Error($t("lib.plugins.migration-plan.text_7448aa34e0"));
  if (withinInstallation(source, target) || withinInstallation(target, source) ||
      (sourceInfo.dev === targetInfo.dev && sourceInfo.ino === targetInfo.ino)) {
    throw new Error($t("lib.plugins.migration-plan.text_e98c64012e"));
  }
  if (!(await lstat(join(source, "plugins"))).isDirectory()) {
    throw new Error($t("lib.plugins.migration-plan.text_ede7ef5421"));
  }
  const git = createLocalGit();
  if (!git) throw new Error($t("lib.plugins.migration-plan.text_2f3a0802da"));
  const topLevel = (await git(target, ["rev-parse", "--show-toplevel"]))?.trimEnd();
  if (!topLevel || await realpath(topLevel) !== target) throw new Error($t("lib.plugins.migration-plan.text_7a414fb75b"));
  const tree = await git(target, ["ls-tree", "-z", "HEAD:plugins"]);
  if (tree === undefined) throw new Error($t("lib.plugins.migration-plan.text_b07310b6e8"));
  const nativeDirectories = new Set(builtInDirectories.values());
  const protectedPaths = new Set<string>();
  for (const entry of tree.split("\0")) {
    const name = /^(?:040000|160000) [^ ]+ [^\t]+\t(.+)$/u.exec(entry)?.[1];
    if (name && nativeDirectories.has(name)) protectedPaths.add(`plugins/${name}`);
  }
  const plugins = await planLegacyPlugins(source, protectedPaths);
  return { version: 1, mode: "dry-run", scope: "legacy-plugins", source, target, plugins } as const;
}

export type LegacyMigrationPlan = Awaited<ReturnType<typeof planMigration>>;
