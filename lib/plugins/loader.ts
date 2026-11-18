import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { GroupTransport } from "../adapters/onebot-groups.ts";
import type { CommandModule, CommandRegistry } from "../commands.ts";
import type { LegacyPlugins } from "./legacy.ts";
import { rejectionReason, repositoryKey } from "./policy.ts";

interface Candidate {
  readonly path: string;
  readonly kind: "package" | "script";
}

export const systemModuleName = "@lotus-yunzai/system";
const builtInDirectories = new Map([
  [systemModuleName, "system"],
  ["@lotus-yunzai/atlas", "atlas"],
  ["@lotus-yunzai/meme", "meme"],
  ["@lotus-yunzai/notice", "notice"],
  ["@lotus-yunzai/group", "group"],
]);

const scriptExtensions = new Set([".js", ".mjs", ".cjs", ".ts"]);
const retiredScripts = new Map([
  ["c56d66b96534430c0b144051ffb5fbec74f8febec3acbb85ddc9c00427faba98", "咕咕牛图库管理器"],
]);

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
    entry.name.endsWith(".js")).map((entry) => entry.name);
  for (const entry of await entriesAt(join(directory, "apps"))) {
    if (entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".js")) {
      scripts.push(join("apps", entry.name));
    }
  }
  return scripts.sort();
}

async function retiredScript(path: string): Promise<string | undefined> {
  const hash = createHash("sha256").update(await readFile(path)).digest("hex");
  return retiredScripts.get(hash);
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
      !scriptExtensions.has(extname(path)) || !(await stat(path)).isFile()) {
    throw new Error("插件入口须是包内的 JS 或 TS 文件。");
  }
  return path;
}

interface PluginServices {
  readonly groups: GroupTransport;
  readonly signal: AbortSignal;
}

export interface PluginLoadRecord {
  readonly name: string;
  readonly status: "loaded" | "rejected" | "failed" | "skipped";
  readonly reason?: string;
}

export async function loadPlugins(
  root: string,
  commands: CommandRegistry,
  legacy: LegacyPlugins,
  services: PluginServices,
): Promise<readonly PluginLoadRecord[]> {
  const report: PluginLoadRecord[] = [];
  const seen = new Map<string, string>();
  const ready: { label: string; entry: string; moduleName?: string }[] = [];
  const reject = (name: string, reason: string, label = name) => {
    console.warn(`[插件] 拒绝加载 ${label}：${reason}`);
    report.push({ name, status: "rejected", reason });
  };
  const allowedScript = async (path: string) => {
    const retired = await retiredScript(path);
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
      const manifest = record(source === undefined ? undefined : JSON.parse(source.replace(/^\uFEFF/u, "")));
      const meta = record(manifest.lotusYunzai);
      const declaredName = typeof manifest.name === "string" ? manifest.name.trim().toLowerCase() : "";
      const name = declaredName || directory.toLowerCase();
      const repository = typeof manifest.repository === "string" ? manifest.repository : record(manifest.repository).url;
      const urls = await gitRepositories(candidate.path);
      if (typeof repository === "string") urls.push(repository);
      const repositories = urls.map(repositoryKey).filter((key) => key !== undefined);
      const names = [directory.toLowerCase(), name, name.split("/").at(-1) ?? "",
        ...repositories, ...repositories.map((key) => key.split("/")[1] ?? "")];
      const games = Array.isArray(meta.games) ? meta.games.filter((game) => typeof game === "string") : [];
      const reason = rejectionReason(names, games);
      if (reason) {
        reject(label, reason, `${label}（${declaredName || repositories[0] || directory}）`);
        continue;
      }
      if (meta.entry !== undefined && (typeof meta.entry !== "string" || !declaredName)) {
        throw new Error("清单模块须声明包名和入口路径。");
      }

      const builtInDirectory = builtInDirectories.get(name);
      if (builtInDirectory !== undefined && directory !== builtInDirectory) {
        reject(label, `${name} 的内置目录为 plugins/${builtInDirectory}。`);
        continue;
      }
      if (commands.hasModule(name)) {
        reject(label, `模块 ${name} 已注册。`);
        continue;
      }
      const identities = [`name:${name}`, ...repositories.map((key) => `repo:${key}`)];
      const duplicate = identities.map((identity) => seen.get(identity)).find((path) => path !== undefined);
      if (duplicate) {
        reject(label, `与 ${duplicate} 重复。`);
        continue;
      }
      if (typeof meta.entry === "string") {
        const entry = await findEntry(candidate.path, meta.entry);
        if (!await allowedScript(entry)) continue;
        ready.push({ label, entry, moduleName: name });
      } else {
        const entries = [];
        for (const file of await legacyEntries(candidate.path)) {
          const entry = await findEntry(candidate.path, file);
          if (await allowedScript(entry)) entries.push({ label: relative(root, entry), entry });
        }
        if (!entries.length) continue;
        ready.push(...entries);
      }
      for (const identity of identities) seen.set(identity, label);
    } catch {
      reject(label, "无法读取插件元数据，或入口路径无效。");
    }
  }

  for (const { label, entry, moduleName } of ready) {
    try {
      const published = await import(pathToFileURL(entry).href);
      if (moduleName) {
        const create = published.createModule;
        if (create !== undefined && typeof create !== "function") {
          throw new Error("createModule 须为模块工厂函数。");
        }
        const module = create ? await create(services) : published.default;
        const { commands: handlers, aliases } = record(module);
        if (handlers === null || typeof handlers !== "object" || Array.isArray(handlers)) {
          throw new Error("入口必须通过默认导出提供 commands。");
        }
        if (aliases !== undefined && (aliases === null || typeof aliases !== "object" || Array.isArray(aliases))) {
          throw new Error("aliases 须为指令别名与本模块指令名的映射。");
        }
        const unregister = commands.registerModule({
          name: moduleName, commands: handlers as CommandModule["commands"], aliases: aliases as CommandModule["aliases"],
        });
        try {
          if (published.apps !== undefined) {
            if (published.apps === null || typeof published.apps !== "object") {
              throw new Error("apps 须导出 V3 插件类。");
            }
            await legacy.register(published, label);
          }
        } catch (error) {
          unregister();
          throw error;
        }
      } else {
        const result = await legacy.register(published, label);
        if (result !== "loaded") {
          const reason = result === "skipped" ? "插件初始化请求跳过。" : "未导出可用的 V3 插件类。";
          console.warn(`[插件] 跳过 ${label}：${reason}`);
          report.push({ name: label, status: "skipped", reason });
          continue;
        }
      }
      console.log(`[插件] 已加载 ${label}。`);
      report.push({ name: label, status: "loaded" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[插件] 加载 ${label} 失败：${message}`);
      report.push({ name: label, status: "failed", reason: "入口加载或初始化失败，请查看宿主日志。" });
    }
  }
  return report;
}
