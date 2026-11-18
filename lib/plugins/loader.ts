import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { GroupTransport } from "../adapters/onebot-groups.ts";
import { builtInDirectories, systemModuleName } from "../builtin-modules.ts";
import type { CommandContext, CommandModule, CommandRegistry } from "../commands.ts";
import type { RuntimeVersion } from "../runtime-version.ts";
import type { LegacyPlugins } from "./legacy.ts";
import { inspectPluginMetadata, pluginScriptExtensions, retiredPluginScript } from "./metadata.ts";

interface Candidate {
  readonly path: string;
  readonly kind: "package" | "script";
}

export { systemModuleName };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isMissing(error: unknown): boolean {
  return record(error).code === "ENOENT";
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

async function entriesAt(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function listCandidates(root: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const entry of await entriesAt(root)) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      candidates.push({ path, kind: "package" });
    } else if (entry.isFile() && extname(entry.name) === ".js") {
      candidates.push({ path, kind: "script" });
    }
  }
  const builtInPaths = new Set([...builtInDirectories.values()].map((directory) => join(root, directory)));
  return candidates.sort((left, right) =>
    Number(builtInPaths.has(right.path)) - Number(builtInPaths.has(left.path)) ||
    left.path.localeCompare(right.path, "en"));
}

async function legacyEntries(directory: string): Promise<string[]> {
  const entries = await entriesAt(directory);
  if (entries.some((entry) => entry.name === "index.js")) return ["index.js"];

  const scripts = entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".") &&
    entry.name.endsWith(".js") && entry.name !== "guoba.support.js").map((entry) => entry.name);
  for (const entry of await entriesAt(join(directory, "apps"))) {
    if (entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".js")) {
      scripts.push(join("apps", entry.name));
    }
  }
  return scripts.sort();
}

async function gitRepositories(directory: string): Promise<string[]> {
  try {
    await stat(join(directory, ".git"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const git = Bun.which("git");
  if (!git) {
    throw new Error("发现 Git 插件，请安装 Git 以检查仓库来源。");
  }
  const process = Bun.spawn([git, "config", "--local", "--no-includes", "--get-regexp", "^remote\\..*\\.url$"], {
    cwd: directory, stdout: "pipe", stderr: "ignore",
  });
  const output = await new Response(process.stdout).text();
  const exit = await process.exited;
  if (exit === 1) return [];
  if (exit !== 0) throw new Error("无法读取插件的 Git 仓库来源。");
  return output.trim().split("\n").map((line) => line.slice(line.indexOf(" ") + 1));
}

async function findEntry(directory: string, value: string): Promise<string> {
  if (isAbsolute(value)) {
    throw new Error("插件入口须使用包内相对路径。");
  }
  const root = await realpath(directory);
  const path = await realpath(resolve(root, value));
  const local = relative(root, path);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) ||
      !pluginScriptExtensions.has(extname(path)) || !(await stat(path)).isFile()) {
    throw new Error("插件入口须是包内的 JS 或 TS 文件。");
  }
  return path;
}

interface PluginServices {
  readonly groups: GroupTransport;
  readonly signal: AbortSignal;
  readonly messageStatistics: (argument: string, context: CommandContext) => Promise<string>;
  readonly runtimeVersion: RuntimeVersion;
  readonly runtimeDiagnostics: (context: CommandContext) => {
    readonly accounts: readonly { readonly id: number; readonly seconds: number }[];
    readonly plugins: readonly PluginLoadTiming[];
  };
}

export interface PluginLoadTiming {
  readonly name: string;
  readonly milliseconds: number;
}

export interface PluginLoadRecord {
  readonly name: string;
  readonly status: "loaded" | "rejected" | "failed" | "skipped";
  readonly reason?: string;
}

export interface PluginLoadReport {
  readonly records: readonly PluginLoadRecord[];
  readonly directories: ReadonlyMap<string, { path: string; packageName: string }>;
  readonly timings: readonly PluginLoadTiming[];
  dispose(): Promise<void>;
}

async function disposeModule(name: string, cleanup: () => unknown): Promise<void> {
  try {
    await cleanup();
  } catch {
    console.warn(`[插件] 清理 ${name} 失败。`);
  }
}

export async function loadPlugins(
  root: string,
  commands: CommandRegistry,
  legacy: LegacyPlugins,
  services: PluginServices,
): Promise<PluginLoadReport> {
  const records: PluginLoadRecord[] = [];
  const timings: PluginLoadTiming[] = [];
  const directories = new Map<string, { path: string; packageName: string }>();
  const cleanups: { name: string; cleanup: () => unknown }[] = [];
  const seen = new Map<string, string>();
  const ready: { label: string; entry: string; moduleName?: string; directory?: string; packageName?: string }[] = [];
  const reject = (name: string, reason: string, label = name) => {
    console.warn(`[插件] 拒绝加载 ${label}：${reason}`);
    records.push({ name, status: "rejected", reason });
  };
  const allowedScript = async (path: string) => {
    const retired = retiredPluginScript(await readFile(path));
    if (!retired) return true;
    const name = relative(root, path);
    reject(name, "图库管理已归并到 atlas。", `${name}（${retired}）`);
    return false;
  };
  for (const candidate of await listCandidates(root)) {
    const label = relative(root, candidate.path);
    try {
      if (candidate.kind === "script") {
        if (await allowedScript(candidate.path)) {
          ready.push({ label, entry: candidate.path });
        }
        continue;
      }

      const directory = basename(candidate.path);
      const source = await readOptional(join(candidate.path, "package.json"));
      const { name, identities, entry: declaredEntry, rejection, rejectionIdentity } = inspectPluginMetadata(
        directory, source, await gitRepositories(candidate.path),
      );
      if (rejection) {
        reject(label, rejection, rejectionIdentity ? `${label}（${rejectionIdentity}）` : label);
        continue;
      }
      if (commands.hasModule(name)) {
        reject(label, `模块 ${name} 已注册。`);
        continue;
      }
      const duplicate = identities.map((identity) => seen.get(identity)).find((path) => path !== undefined);
      if (duplicate) {
        reject(label, `与 ${duplicate} 重复。`);
        continue;
      }
      if (declaredEntry !== undefined) {
        const entry = await findEntry(candidate.path, declaredEntry);
        if (!await allowedScript(entry)) continue;
        ready.push({ label, entry, moduleName: name, directory: candidate.path, packageName: name });
      } else {
        const entries = [];
        for (const file of await legacyEntries(candidate.path)) {
          const entry = await findEntry(candidate.path, file);
          if (await allowedScript(entry)) {
            entries.push({ label: relative(root, entry), entry, directory: candidate.path, packageName: name });
          }
        }
        if (!entries.length) continue;
        ready.push(...entries);
      }
      for (const identity of identities) seen.set(identity, label);
    } catch {
      reject(label, "无法读取插件元数据，或入口路径无效。");
    }
  }

  for (const { label, entry, moduleName, directory, packageName } of ready) {
    const started = performance.now();
    let cleanup: (() => unknown) | undefined;
    try {
      const published = await import(pathToFileURL(entry).href);
      if (moduleName) {
        const create = published.createModule;
        if (create !== undefined && typeof create !== "function") {
          throw new Error("createModule 须为模块工厂函数。");
        }
        const module = create ? await create(services) : published.default;
        const { commands: handlers, aliases, dispose } = record(module);
        if (dispose !== undefined) {
          if (typeof dispose !== "function") throw new Error("dispose 须为模块清理函数。");
          cleanup = () => dispose.call(module);
        }
        if (handlers === null || typeof handlers !== "object" || Array.isArray(handlers)) {
          throw new Error("入口必须通过默认导出提供 commands。");
        }
        if (aliases !== undefined && (aliases === null || typeof aliases !== "object" || Array.isArray(aliases))) {
          throw new Error("aliases 须为指令别名与本模块指令名的映射。");
        }
        const unregister = commands.registerModule({
          name: moduleName, commands: handlers as CommandModule["commands"], aliases: aliases as CommandModule["aliases"],
        }, label);
        try {
          if (published.apps !== undefined) {
            if (published.apps === null || typeof published.apps !== "object") {
              throw new Error("apps 须导出 V3 插件类。");
            }
            await legacy.register(published, label, packageName);
          }
        } catch (error) {
          unregister();
          throw error;
        }
      } else {
        const result = await legacy.register(published, label, packageName);
        if (result !== "loaded") {
          const reason = result === "skipped" ? "插件初始化请求跳过。" : "未导出可用的 V3 插件类。";
          console.warn(`[插件] 跳过 ${label}：${reason}`);
          records.push({ name: label, status: "skipped", reason });
          continue;
        }
      }
      console.log(`[插件] 已加载 ${label}。`);
      records.push({ name: label, status: "loaded" });
      timings.push({ name: label, milliseconds: performance.now() - started });
      if (directory && packageName) directories.set(basename(directory), { path: directory, packageName });
      if (cleanup) cleanups.push({ name: label, cleanup });
    } catch (error) {
      if (cleanup) await disposeModule(label, cleanup);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[插件] 加载 ${label} 失败：${message}`);
      records.push({ name: label, status: "failed", reason: "入口加载或初始化失败，请查看宿主日志。" });
    }
  }
  let disposal: Promise<void> | undefined;
  return {
    records, directories, timings,
    dispose() {
      return disposal ??= (async () => {
        for (const { name, cleanup } of cleanups.splice(0).reverse()) await disposeModule(name, cleanup);
      })();
    },
  };
}
