import { lstat } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const pathKeys = [
  "LOTUS_ATLAS_DATA_DIR", "LOTUS_PROFILE_DIR", "LOTUS_ZZZ_PANEL_DIR", "LOTUS_ZZZ_SHOWCASE_DIR",
  "LOTUS_GROUP_CONFIG", "LOTUS_MEME_DB",
] as const;
const trimmedPathKeys = [
  "LOTUS_ATLAS_THEME_DIR", "LOTUS_GENSHIN_PANEL_DIR", "LOTUS_GENSHIN_PANEL_RANK_DIR",
  "LOTUS_GENSHIN_WISH_STATE_DIR", "LOTUS_STAR_RAIL_WARP_STATE_DIR", "LOTUS_GUIDES_ROLE_DIR",
] as const;
const keys = [...pathKeys, ...trimmedPathKeys];
type RuntimePaths = Readonly<Record<string, string | undefined>>;
const alreadyPersistent = new Set(["config", "data", "logs", "internal"]);

function configuredRuntimePaths(root: string, env: RuntimePaths): string[] {
  const theme = env.LOTUS_ATLAS_THEME_DIR?.trim();
  const adjacentFont = theme ? join(dirname(resolve(root, theme)), "fonts", "MiSans-VF.ttf") : undefined;
  const db = env.LOTUS_MEME_DB;
  const sidecars = db ? ["-wal", "-shm", "-journal"].map(suffix => resolve(root, db) + suffix) : [];
  const configured = [...pathKeys.map(key => env[key]), ...trimmedPathKeys.map(key => env[key]?.trim()), adjacentFont, ...sidecars];
  const paths = configured.flatMap(value => {
    if (!value) return [];
    const path = relative(root, resolve(root, value));
    if (!path) throw new Error("运行数据配置使用宿主根目录，无法安全切换版本。");
    if (isAbsolute(path) || path === ".." || path.startsWith(".." + sep)) return [];
    const [first] = path.split(sep);
    if (alreadyPersistent.has(first!) || first === ".env" || first?.startsWith(".env.")) return [];
    return [path.split(sep).join("/")];
  });
  return [...new Set(paths)].sort().filter(path => !paths.some(parent => path.startsWith(parent + "/")));
}

async function existingPaths(root: string, paths: readonly string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const path of paths) {
    try {
      await lstat(join(root, path));
      existing.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return existing;
}

export async function readUpdateRuntimePaths(root: string, signal: AbortSignal, workerEnv: NodeJS.ProcessEnv): Promise<string[]> {
  // Match the worker's Bun dotenv ordering, including the environment inherited from the supervisor.
  // The separate evaluator loads no application or Bun preloads and emits only these path settings.
  const command = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, Bun.env[key]]))))`;
  const env = { ...workerEnv };
  delete env.BUN_OPTIONS;
  const child = Bun.spawn([process.execPath, "--config=" + devNull, "--no-install", "-e", command], {
    cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]), killSignal: "SIGKILL", maxBuffer: 64 * 1024,
  });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  signal.throwIfAborted();
  if (code !== 0) throw new Error("无法读取工作进程的运行数据路径。");
  return existingPaths(root, configuredRuntimePaths(root, JSON.parse(text) as RuntimePaths));
}

export async function verifyMovedRuntimePaths(root: string, previous: string, env: RuntimePaths): Promise<void> {
  const paths = configuredRuntimePaths(root, env);
  // An older supervisor cannot move these paths. Do not acknowledge readiness if its archive still owns them.
  if ((await existingPaths(previous, paths)).length) throw new Error("指定的运行数据仍留在旧版本，已拒绝接管。");
}
