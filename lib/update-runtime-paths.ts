import { lstat, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { configuredGameResourcePaths, gameResourcePathKeys } from "./update-game-resource-paths.ts";

const pathKeys = [
  "LOTUS_ATLAS_DATA_DIR", "LOTUS_PROFILE_DIR", "LOTUS_ZZZ_PANEL_DIR", "LOTUS_ZZZ_SHOWCASE_DIR",
  "LOTUS_GROUP_CONFIG", "LOTUS_MEME_DB",
] as const;
const trimmedPathKeys = [
  "LOTUS_ATLAS_THEME_DIR", "LOTUS_GENSHIN_PANEL_DIR", "LOTUS_GENSHIN_PANEL_RANK_DIR",
  "LOTUS_GENSHIN_WISH_STATE_DIR", "LOTUS_STAR_RAIL_WARP_STATE_DIR", "LOTUS_GUIDES_ROLE_DIR",
] as const;
const keys = [...pathKeys, ...trimmedPathKeys, ...gameResourcePathKeys, "LOTUS_ATLAS_THEME_SOURCE_DIR", "LOTUS_CHARACTER_GALLERY_DIR",
  "LOTUS_PASSPORT_QR_RESOURCES", "LOTUS_DAILY_NOTE_RESOURCES"];
type RuntimePaths = Readonly<Record<string, string | undefined>>;
const alreadyPersistent = new Set(["config", "data", "logs", "internal"]);
const atlasBackgrounds = ["anemo", "cryo", "dendro", "electro", "geo", "hydro", "pyro", "quantum", "sr"]
  .map(element => `bg/bg-${element}.webp`);
const atlasSourceAssets = [
  ...atlasBackgrounds, ...atlasBackgrounds.map(path => `common/${path}`),
  "card-bg.png", "common/cont/card-bg.png", "fonts/HYWH-65W.ttf", "common/font/HYWH-65W.ttf",
  "fonts/MiSans-VF.ttf", "portraits",
  "meta-gs/character/空/imgs/splash.webp", "meta-gs/character/荧/imgs/splash.webp",
];
const passportFonts = [
  "miao-theme/fonts/HYWH-65W.ttf", "fonts/MiSans-VF.ttf", "source-templates/miao-stat/fonts/NZBZ.ttf",
];
const passportBackdrop = "miao-theme/bg/bg-hydro.webp";
const passportAssets = [
  ...passportFonts, passportBackdrop, "source-templates/miao-stat/fonts/tttgbnumber.ttf",
  "source-templates/miao/common/theme/bg-01.jpg", "source-templates/miao/common/theme/main-01.png",
];
const dailyNoteAssets = [
  "miao-theme/fonts/HYWH-65W.ttf", "fonts/MiSans-VF.ttf", "source-templates/miao-stat/fonts/tttgbnumber.ttf",
  ...["树脂", "洞天宝钱", "委托", "派遣", "周本", "参量质变仪"].map(icon => `source-templates/genshin/note-icons/gs/${icon}.png`),
];

function configuredAssetPaths(env: RuntimePaths): string[] {
  const assets = configuredGameResourcePaths(env);
  const donor = env.LOTUS_ATLAS_THEME_SOURCE_DIR?.trim();
  if (donor && !env.LOTUS_ATLAS_THEME_DIR?.trim()) {
    assets.push(...atlasSourceAssets.map(path => join(donor, path)), join(dirname(donor), "fonts", "MiSans-VF.ttf"));
  }
  const gallery = env.LOTUS_CHARACTER_GALLERY_DIR;
  if (gallery) assets.push(join(gallery, "zzz-character"));
  if (gallery?.trim()) assets.push(...["gs-character", "sr-character", "zzz-character"].map(path => join(gallery.trim(), path)));

  const login = env.LOTUS_PASSPORT_QR_RESOURCES;
  if (login) assets.push(...passportAssets.map(path => join(login, path)));
  const checkin = login?.trim();
  if (checkin) assets.push(...[...passportFonts, passportBackdrop].map(path => join(checkin, path)));
  const dailyNote = env.LOTUS_DAILY_NOTE_RESOURCES;
  if (dailyNote) assets.push(...dailyNoteAssets.map(path => join(dailyNote, path)));
  return assets;
}

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep);
}

function persistentPath(path: string): boolean {
  const [first] = path.split(sep);
  return alreadyPersistent.has(first!) || first === ".env" || first?.startsWith(".env.") === true;
}

function configuredRuntimePaths(root: string, env: RuntimePaths): string[] {
  const theme = env.LOTUS_ATLAS_THEME_DIR?.trim();
  const adjacentFont = theme ? join(dirname(resolve(root, theme)), "fonts", "MiSans-VF.ttf") : undefined;
  const db = env.LOTUS_MEME_DB;
  const sidecars = db ? ["-wal", "-shm", "-journal"].map(suffix => resolve(root, db) + suffix) : [];
  const configured = [...pathKeys.map(key => env[key]), ...trimmedPathKeys.map(key => env[key]?.trim()), adjacentFont, ...sidecars];
  const paths = configured.flatMap(value => {
    if (!value) return [];
    const absolute = resolve(root, value);
    const path = relative(root, absolute);
    if (!path) throw new Error("运行数据配置使用宿主根目录，无法安全切换版本。");
    if (!within(root, absolute) || persistentPath(path)) return [];
    return [path.split(sep).join("/")];
  });
  return paths;
}

async function existingAssetPath(root: string, source: string, value: string): Promise<string | undefined> {
  const absolute = resolve(root, value);
  if (!within(root, absolute)) return;
  const asset = relative(root, absolute);
  if (!asset) throw new Error("原主题或素材配置使用宿主根目录，无法安全切换版本。");
  try {
    const installed = join(source, asset);
    await lstat(installed);
    let path = source;
    for (const part of asset.split(sep)) {
      path = join(path, part);
      if (!(await lstat(path)).isSymbolicLink()) continue;
      const targets = path === installed ? [await realpath(path)] : await Promise.all([realpath(path), realpath(installed)]);
      if (targets.some(target => [root, source].some(base =>
        within(base, target) && !persistentPath(relative(base, target))))) {
        throw new Error("原素材或旧资料经过指向安装目录内的链接，无法安全切换版本。");
      }
      // Moving the link keeps external resources at their existing location.
      return relative(source, path);
    }
    return asset;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
}

async function findRuntimePaths(root: string, source: string, env: RuntimePaths): Promise<string[]> {
  const assets: string[] = [];
  for (const value of new Set(configuredAssetPaths(env))) {
    const path = await existingAssetPath(root, source, value);
    if (path && !persistentPath(path)) assets.push(path.split(sep).join("/"));
  }
  const paths = [...configuredRuntimePaths(root, env), ...assets];
  return existingPaths(source, [...new Set(paths)].sort().filter(path => !paths.some(parent => path.startsWith(parent + "/"))));
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
  return findRuntimePaths(root, root, JSON.parse(text) as RuntimePaths);
}

export async function verifyMovedRuntimePaths(root: string, previous: string, env: RuntimePaths): Promise<void> {
  // An older supervisor cannot move these paths. Do not acknowledge readiness if its archive still owns them.
  if ((await findRuntimePaths(root, previous, env)).length) throw new Error("指定的运行数据仍留在旧版本，已拒绝接管。");
}
