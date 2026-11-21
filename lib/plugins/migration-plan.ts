import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { devNull } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { builtInDirectories } from "../builtin-modules.ts";
import { isManagedPluginDirectory } from "../managed-update-protocol.ts";
import { inspectPluginMetadata, pluginScriptExtensions, retiredPluginScript } from "./metadata.ts";

export type LegacyPluginPlanEntry =
  | { readonly path: string; readonly status: "archive"; readonly kind: "directory" | "script"; readonly reason: string;
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
    if (!first.isFile()) throw new Error("插件元数据或入口须为普通文件。");
    if (first.size > maximum) throw new PluginScanLimit("插件元数据或入口超过预检大小上限。");
    const contents = Buffer.alloc(first.size + 1);
    let position = 0;
    while (position < contents.length) {
      const { bytesRead } = await file.read(contents, position, contents.length - position, position);
      if (bytesRead === 0) break;
      position += bytesRead;
    }
    const last = await file.stat();
    if (position !== first.size || last.size !== first.size || last.mtimeMs !== first.mtimeMs) {
      throw new Error("插件元数据或入口在读取期间发生变化。");
    }
    return contents.subarray(0, position);
  } finally {
    await file.close();
  }
}

async function gitRepositories(plugin: string, targetBuiltInName: string | undefined, manifestName: string) {
  const dotGit = join(plugin, ".git");
  const entry = await optionalStat(dotGit);
  if (!entry) return [];
  // Managed submodule checkouts already declare their module identity in the physical manifest.
  if (entry.isFile() && targetBuiltInName === manifestName) return [];
  // A copied linked worktree does not establish ownership of its external Git metadata.
  if (!entry.isDirectory()) throw new Error("插件的 Git 配置须在副本目录内。");
  const config = await readRegularFile(join(dotGit, "config"), maximumMetadataBytes);
  const git = Bun.which("git");
  if (!git) throw new Error("无法读取插件的 Git 来源。");
  const child = Bun.spawn([git, "config", "--file", "-", "--no-includes", "-z", "--get-regexp", "^remote\\..*\\.url$"], {
    cwd: plugin, stdin: config, stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(1_500),
    killSignal: "SIGKILL", maxBuffer: maximumMetadataBytes * 2,
    env: { PATH: process.env.PATH, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull },
  });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code === 1) return [];
  if (code !== 0) throw new Error("无法读取插件的 Git 来源。");
  return output.split("\0").filter(Boolean).map(line => line.slice(line.indexOf("\n") + 1));
}

async function entriesAt(path: string): Promise<Dirent[]> {
  const entry = await optionalStat(path);
  if (!entry) return [];
  if (!entry.isDirectory()) throw new Error("插件根或入口目录须为实体目录。");
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
    throw new Error("插件入口须为包内相对脚本。");
  }
  let parent = directory;
  for (const part of local.split(sep).slice(0, -1)) {
    parent = join(parent, part);
    if (!(await lstat(parent)).isDirectory()) throw new Error("插件入口须位于实体目录。");
  }
  return readRegularFile(file, maximumScriptBytes);
}

function scriptPlan(path: string, bytes: Uint8Array): LegacyPluginPlanEntry {
  const retired = retiredPluginScript(bytes);
  return retired
    ? { path, status: "archive", kind: "script", reason: retired.reason, replacementModule: retired.module }
    : { path, status: "retain" };
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
      plan.push({ path, status: "review", reason: "插件路径不适合自动归档，或为符号链接。" });
      continue;
    }
    try {
      if (!entry.isDirectory()) {
        if (occupiesTarget) {
          plan.push({ path, status: "review", reason: "与目标内置插件路径相同，源路径并非内置目录。" });
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
          plan.push(scriptPlan(path, await readRegularFile(source, maximumScriptBytes)));
        }
        continue;
      }
      const manifest = join(source, "package.json");
      const contents = await optionalStat(manifest) ? (await readRegularFile(manifest, maximumMetadataBytes)).toString("utf8") : undefined;
      const declaration = inspectPluginMetadata(entry.name, contents, []);
      const expectedNativeName = occupiesTarget ? nativeNames.get(entry.name) : undefined;
      const repositories = await gitRepositories(source, expectedNativeName, declaration.declaredName);
      const metadata = repositories.length ? inspectPluginMetadata(entry.name, contents, repositories) : declaration;
      if (metadata.rejectionKind === "policy" && metadata.rejection) {
        plan.push({ path, status: "archive", kind: "directory", reason: metadata.rejection });
        continue;
      }
      if (occupiesTarget) {
        plan.push(expectedNativeName === metadata.declaredName
          ? { path, status: "built-in" }
          : { path, status: "review", reason: "旧插件占用目标内置目录，身份须先核对。" });
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
        plan.push({ path, status: "review", reason: `与 ${duplicate} 声明的插件身份重复。` });
        continue;
      }
      const scripts = metadata.entry === undefined ? await legacyScripts(source) : [metadata.entry];
      const archive: LegacyPluginPlanEntry[] = [];
      for (const script of scripts) {
        const result = scriptPlan(`${path}/${script}`, await readScript(source, script));
        if (result.status === "archive") archive.push(result);
      }
      for (const identity of metadata.identities) seen.set(identity, path);
      plan.push({ path, status: "retain" }, ...archive);
    } catch (error) {
      const reason = error instanceof PluginScanLimit ? error.message : "无法安全读取插件元数据、Git 来源或入口。";
      plan.push({ path, status: "scan-error", reason });
    }
  }
  return plan;
}
