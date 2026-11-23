import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isUpdateDotenvPath, persistentDirectories } from "./update-activation.ts";
import { configuredGameResourcePaths, gameResourcePathKeys } from "./update-game-resource-paths.ts";
import { readPathLink, resolveLinkedPath } from "./update-linked-path.ts";

const pathKeys = [
  "LOTUS_ATLAS_DATA_DIR", "LOTUS_PROFILE_DIR", "LOTUS_ZZZ_PANEL_DIR", "LOTUS_ZZZ_SHOWCASE_DIR",
  "LOTUS_GROUP_CONFIG", "LOTUS_MEME_DB",
] as const;
const trimmedPathKeys = [
  "LOTUS_ATLAS_THEME_DIR", "LOTUS_GENSHIN_PANEL_DIR", "LOTUS_GENSHIN_PANEL_RANK_DIR",
  "LOTUS_GENSHIN_MONTHLY_DIR", "LOTUS_GENSHIN_LEGACY_MONTHLY_DIR",
  "LOTUS_GENSHIN_WISH_STATE_DIR", "LOTUS_STAR_RAIL_WARP_STATE_DIR", "LOTUS_GUIDES_ROLE_DIR",
] as const;
const keys = [...pathKeys, ...trimmedPathKeys, ...gameResourcePathKeys, "LOTUS_ATLAS_THEME_SOURCE_DIR", "LOTUS_CHARACTER_GALLERY_DIR",
  "LOTUS_PASSPORT_QR_RESOURCES", "LOTUS_DAILY_NOTE_RESOURCES", "LOTUS_PUBLIC_IMAGE_DIR", "LOTUS_DEVICE_INFO_APK", "LOTUS_MEME_CONFIG_DIR",
  "LOTUS_DONATION_RESOURCES", "TESSDATA_PREFIX"];
type RuntimePaths = Readonly<Record<string, string | undefined>>;
const alreadyPersistent = new Set<string>(persistentDirectories);
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
  const donation = env.LOTUS_DONATION_RESOURCES?.trim();
  if (donation) assets.push(join(donation, "alipay-lotus.jpg"), join(donation, "wechat-lotus.png"));
  const deviceApk = env.LOTUS_DEVICE_INFO_APK?.trim();
  if (deviceApk) assets.push(deviceApk);
  return assets;
}

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep);
}

function persistentPath(path: string): boolean {
  const first = path.split(sep)[0]!;
  return alreadyPersistent.has(first) || isUpdateDotenvPath(first);
}

async function installedLocation(root: string, value: string): Promise<string | undefined> {
  const absolute = resolve(root, value);
  return within(root, absolute) ? absolute : resolveLinkedPath(absolute, { match: path => within(root, path) });
}

const sqliteSidecars = ["-wal", "-shm", "-journal"];

async function configuredRuntimePaths(root: string, source: string, env: RuntimePaths): Promise<string[]> {
  const theme = env.LOTUS_ATLAS_THEME_DIR?.trim();
  const adjacentFont = theme ? join(dirname(resolve(root, theme)), "fonts", "MiSans-VF.ttf") : undefined;
  const db = env.LOTUS_MEME_DB;
  // The usage database is named from the configured catalog spelling. SQLite's own
  // companions are named from the resolved file for each of these two databases.
  const usage = db ? `${db}.usage.sqlite` : undefined;
  const configured = [...pathKeys.map(key => env[key]), ...trimmedPathKeys.map(key => env[key]?.trim()), adjacentFont, usage];
  const paths: string[] = [];
  const add = (absolute: string) => {
    if (!within(root, absolute)) return;
    const path = relative(root, absolute);
    if (!path) throw new Error("运行数据配置使用宿主根目录，无法安全切换版本。");
    if (!persistentPath(path)) paths.push(path.split(sep).join("/"));
  };
  async function readSnapshot<T>(path: string, read: (location: string) => Promise<T>): Promise<T> {
    if (source !== root && within(root, path)) {
      // Persistent ancestors may have moved to the new tree while a custom target stayed in the archive.
      try {
        return await read(join(source, relative(root, path)));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }
    return read(path);
  }
  const resolveState = async (absolute: string) => {
    const physical = await resolveLinkedPath(absolute, {
      onLink: add,
      readLink: path => readSnapshot(path, readPathLink),
    });
    if (physical) add(physical);
    return physical;
  };
  // The default state paths are moved by name. Follow their links to keep any local targets too.
  const dotenv = (await Promise.all((source === root ? [root] : [source, root]).map(path => readdir(path))))
    .flat().filter(isUpdateDotenvPath);
  for (const path of new Set([...persistentDirectories, ...dotenv])) await resolveState(join(root, path));
  // Runtime YAML can also be linked out of either of the two supported configuration directories.
  for (const path of ["config", "config/config"]) {
    const directory = await resolveState(join(root, path));
    if (!directory) continue;
    const files = await readSnapshot(directory, path => readdir(path, { withFileTypes: true })).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      return [];
    });
    for (const file of files) {
      if (file.isSymbolicLink() && /\.ya?ml$/u.test(file.name)) await resolveState(join(directory, file.name));
    }
  }
  const memeConfig = env.LOTUS_MEME_CONFIG_DIR ?? "data/meme/config";
  if (memeConfig) {
    // The runtime follows configuration links even when the editable form rejects them.
    const directory = resolve(root, memeConfig);
    if (await resolveState(directory)) {
      for (const name of ["meme", "access", "protect", "server", "stat", "other"]) {
        await resolveState(join(directory, `${name}.yaml`));
      }
    }
  }
  if (env.TESSDATA_PREFIX) {
    const models = resolve(root, env.TESSDATA_PREFIX);
    for (const model of ["chi_sim.traineddata", "eng.traineddata"]) {
      const target = join(models, model);
      const physical = await resolveLinkedPath(target, { readLink: location => readSnapshot(location, readPathLink) });
      if (physical && (await readSnapshot(physical, location => lstat(location))).isFile()) await resolveState(target);
    }
  }
  for (const value of new Set(configured)) {
    if (!value) continue;
    const absolute = resolve(root, value);
    const physical = await resolveState(absolute);
    if (value === db || value === usage) {
      for (const suffix of sqliteSidecars) await resolveState((physical ?? absolute) + suffix);
    }
  }
  return paths;
}

async function archivedAssetLink(root: string, archive: string, asset: string): Promise<string | undefined> {
  let path = archive;
  try {
    for (const part of asset.split(sep)) {
      path = join(path, part);
      if (!(await lstat(path)).isSymbolicLink()) continue;
      const link = relative(archive, path);
      const target = resolve(root, dirname(link), await readlink(path), relative(path, join(archive, asset)));
      // A relative link can go stale in the archive when data/ has already moved to the active checkout.
      const locations = within(root, target) ? [target, join(archive, relative(root, target))] : [target];
      for (const location of locations) {
        try {
          await realpath(location);
          return link;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        }
      }
      return;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
}

async function existingAssetPath(root: string, source: string, value: string, allowRoot = false): Promise<string | undefined> {
  const installedPath = await installedLocation(root, value);
  if (!installedPath) return;
  const asset = relative(root, installedPath);
  if (!asset) {
    if (allowRoot) return;
    throw new Error("原主题或素材配置使用宿主根目录，无法安全切换版本。");
  }
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
    if (source !== root) return archivedAssetLink(root, source, asset);
  }
}

async function findRuntimePaths(root: string, source: string, env: RuntimePaths): Promise<string[]> {
  const installed = await realpath(root);
  const snapshot = root === source ? installed : source;
  const selected: (string | undefined)[] = [];
  const publicImages = env.LOTUS_PUBLIC_IMAGE_DIR?.trim();
  // The checkout itself can be the access boundary without being a dedicated image directory to move.
  if (publicImages) selected.push(await existingAssetPath(installed, snapshot, publicImages, true));
  for (const value of new Set(configuredAssetPaths(env))) {
    selected.push(await existingAssetPath(installed, snapshot, value));
  }
  const assets = selected.flatMap(path => path && !persistentPath(path) ? [path.split(sep).join("/")] : []);
  const paths = [...await configuredRuntimePaths(installed, snapshot, env), ...assets];
  return existingPaths(snapshot, [...new Set(paths)].sort().filter(path => !paths.some(parent => path.startsWith(parent + "/"))));
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
