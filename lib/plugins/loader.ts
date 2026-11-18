import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandModule, CommandRegistry } from "../commands.ts";
import { rejectionReason, repositoryKey } from "./policy.ts";

interface Candidate {
  readonly path: string;
  readonly kind: "package" | "script";
}

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

async function listCandidates(root: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const directory of [root, join(root, "example")]) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "example") {
        continue;
      }
      const path = join(directory, entry.name);
      if (directory === root && entry.isDirectory()) {
        candidates.push({ path, kind: "package" });
      } else if (entry.isFile() && scriptExtensions.has(extname(entry.name))) {
        candidates.push({ path, kind: "script" });
      }
    }
  }
  return candidates.sort((left, right) => left.path < right.path ? -1 : Number(left.path !== right.path));
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

export async function loadPlugins(root: string, commands: CommandRegistry): Promise<void> {
  const seen = new Map<string, string>();
  const ready: { label: string; name: string; entry: string }[] = [];
  for (const candidate of await listCandidates(root)) {
    const label = relative(root, candidate.path);
    try {
      if (candidate.kind === "script") {
        const hash = createHash("sha256").update(await readFile(candidate.path)).digest("hex");
        const retired = retiredScripts.get(hash);
        if (retired) console.warn(`[插件] 拒绝加载 ${label}（${retired}）：图库管理已归并到 atlas。`);
        continue;
      }

      const directory = basename(candidate.path);
      const source = await readOptional(join(candidate.path, "package.json"));
      const manifest = record(source === undefined ? undefined : JSON.parse(source.replace(/^\uFEFF/u, "")));
      const meta = record(manifest.lotusYunzai);
      const name = typeof manifest.name === "string" ? manifest.name.trim().toLowerCase() : "";
      const repository = typeof manifest.repository === "string" ? manifest.repository : record(manifest.repository).url;
      const urls = await gitRepositories(candidate.path);
      if (typeof repository === "string") urls.push(repository);
      const repositories = urls.map(repositoryKey).filter((key) => key !== undefined);
      const names = [directory.toLowerCase(), name, name.split("/").at(-1) ?? "",
        ...repositories, ...repositories.map((key) => key.split("/")[1] ?? "")];
      const games = Array.isArray(meta.games) ? meta.games.filter((game) => typeof game === "string") : [];
      const reason = rejectionReason(names, games);
      if (reason) {
        console.warn(`[插件] 拒绝加载 ${label}（${name || repositories[0] || directory}）：${reason}`);
        continue;
      }
      if (typeof meta.entry !== "string" || !name) {
        continue;
      }

      if (commands.hasModule(name)) {
        console.warn(`[插件] 拒绝加载 ${label}：模块 ${name} 已注册。`);
        continue;
      }
      const identities = [`name:${name}`, ...repositories.map((key) => `repo:${key}`)];
      const duplicate = identities.map((identity) => seen.get(identity)).find((path) => path !== undefined);
      if (duplicate) {
        console.warn(`[插件] 拒绝加载 ${label}：与 ${duplicate} 重复。`);
        continue;
      }
      const entry = await findEntry(candidate.path, meta.entry);
      for (const identity of identities) seen.set(identity, label);
      ready.push({ label, name, entry });
    } catch {
      console.warn(`[插件] 拒绝加载 ${label}：无法读取插件元数据，或入口路径无效。`);
    }
  }

  for (const { label, name, entry } of ready) {
    try {
      const plugin: unknown = (await import(pathToFileURL(entry).href)).default;
      const handlers = record(plugin).commands;
      if (handlers === null || typeof handlers !== "object" || Array.isArray(handlers)) {
        throw new Error("入口必须通过默认导出提供 commands。");
      }
      commands.registerModule({ name, commands: handlers as CommandModule["commands"] });
      console.log(`[插件] 已加载 ${label}。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[插件] 加载 ${label} 失败：${message}`);
    }
  }
}
