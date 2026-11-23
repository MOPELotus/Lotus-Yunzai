import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { genshinGachaPools } from "../packages/hoyo-client/genshin-gacha.ts";
import { readPanel, type PanelCatalog } from "../plugins/genshin/panel/model.ts";
import { genshinStrategySource } from "../plugins/guides/genshin-strategy.ts";
import { guideCollectionKeys } from "../plugins/guides/guide-configuration.ts";
import { parseGuideCollections } from "../plugins/guides/role-guide-collections.ts";
import { guideGames, safeGuideName, type GuideGame } from "../plugins/guides/role-guide-input.ts";
import { isGuideImage, roleImageLimit } from "../plugins/guides/role-image-files.ts";
import { zzzStrategyOptions } from "../plugins/guides/zzz-strategy.ts";
import { readLegacyPanel } from "../plugins/starrail/panel-model.ts";
import { readZzzFlatLegacyGacha } from "../plugins/zzz/gacha-legacy.ts";
import { withinInstallation } from "./plugins/migration-plan.ts";

const numeric = /^[1-9]\d{0,18}$/u;
const panelUid = /^[1-9]\d{8,9}\.json$/u;
const zzzUid = /^[1-9]\d{7,9}\.json$/u;
const genshinPools = new Set(["100.json", ...genshinGachaPools.map(({ type }) => `${type}.json`)]);
const panelCatalog: PanelCatalog = { characters: {}, artifacts: new Map(), artifactSets: new Map() };
const legacyRoleMaterials = ["gs/友人A", "gs/other", "sr/小橙子啊", "sr/other"] as const;

const scopes = [
  { path: "data/gachaJson", nesting: 2, active: (name: string) => genshinPools.has(name), maxMiB: 64 },
  { path: "data/PlayerData/gs", nesting: 0, active: (name: string) => panelUid.test(name), maxMiB: 8 },
  { path: "data/PlayerData/sr", nesting: 0, active: (name: string) => panelUid.test(name), maxMiB: 8 },
  { path: "data/ZZZ-Plugin/gacha", nesting: 0, active: (name: string) => zzzUid.test(name), maxMiB: 32 },
  { path: "data/textJson", nesting: 0, active: () => false, maxMiB: 32 },
] as const;

type Scope = (typeof scopes)[number]["path"];
type GameDataCount = { readonly path: string; files: number; bytes: number };

function sourceChanged() {
  return new Error("旧游戏数据在迁移过程中发生变化，请使用停写后的安装副本。");
}

async function named(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function unchanged(expected: Stats, current: Stats | undefined) {
  return current && expected.dev === current.dev && expected.ino === current.ino && expected.size === current.size &&
    expected.ctimeMs === current.ctimeMs && expected.mtimeMs === current.mtimeMs &&
    expected.mode === current.mode && expected.nlink === current.nlink;
}

async function readSnapshot(path: string, expected: Stats, signal?: AbortSignal) {
  if (await realpath(path) !== path) throw sourceChanged();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!unchanged(expected, await file.stat())) throw sourceChanged();
    const bytes = Buffer.alloc(expected.size);
    for (let offset = 0; offset < bytes.length;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw sourceChanged();
      offset += bytesRead;
    }
    if (!unchanged(expected, await file.stat()) || !unchanged(expected, await named(path)) || await realpath(path) !== path) {
      throw sourceChanged();
    }
    return bytes;
  } finally {
    await file.close();
  }
}

function archiveRoot(path: Scope) {
  return join("backup", "legacy-data", path.slice("data/".length));
}

async function validateActive(scope: Scope, name: string, bytes: Buffer, destination: string) {
  try {
    const uid = name.slice(0, -5);
    if (scope === "data/ZZZ-Plugin/gacha") {
      if (!await readZzzFlatLegacyGacha([dirname(destination)], uid)) throw new Error("Missing archive");
      return;
    }
    const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (scope === "data/gachaJson" && !Array.isArray(input)) throw new Error("Expected pool array");
    if (scope === "data/PlayerData/gs" && !readPanel(uid, input, panelCatalog, true, true)) throw new Error("Missing panel");
    if (scope === "data/PlayerData/sr") readLegacyPanel(uid, input);
  } catch {
    throw new Error(`旧游戏数据 ${scope} 含无法由当前版本读取的文件。`);
  }
}

/** Adds verified legacy gameplay data to the migration's private state directory. */
export async function stageLegacyGameData(sourcePath: string, stateDirectory: string, signal?: AbortSignal) {
  const [source, stage] = await Promise.all([realpath(sourcePath), realpath(stateDirectory)]);
  const stageInfo = await lstat(stage);
  if (withinInstallation(source, stage) || withinInstallation(stage, source) ||
      !(await lstat(source)).isDirectory() || stage !== resolve(stateDirectory) || !stageInfo.isDirectory() || (stageInfo.mode & 0o077)) {
    throw new Error("旧游戏数据暂存必须使用独立的私有实体目录。");
  }
  const dirs = new Map<string, Stats>();
  const files = new Map<string, Stats>();
  const active = new Map<string, GameDataCount>();
  const archived = new Map<string, GameDataCount>();

  async function sourceDirectory(path: string, optional = false): Promise<boolean> {
    if (dirs.has(path)) return true;
    if (path !== source && !await sourceDirectory(dirname(path), optional)) return false;
    const info = await named(path);
    if (!info) return false;
    if (!info.isDirectory() || await realpath(path) !== path) {
      if (optional) return false;
      throw new Error("旧游戏数据须位于副本的实体目录内。");
    }
    dirs.set(path, info);
    return true;
  }

  async function ensureStageDirectory(path: string) {
    if (path !== stage) {
      await ensureStageDirectory(dirname(path));
      if (!await named(path)) await mkdir(path, { mode: 0o700 });
    }
    const info = await lstat(path);
    if (!info.isDirectory() || (info.mode & 0o077) || await realpath(path) !== path) {
      throw new Error("旧游戏数据暂存路径须为私有实体目录。");
    }
  }

  async function publishFile(root: string, folders: readonly string[], name: string, bytes: Buffer,
    totals: Map<string, GameDataCount>) {
    const destination = join(stage, root, ...folders, name);
    await ensureStageDirectory(dirname(destination));
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    const count = totals.get(root) ?? { path: root, files: 0, bytes: 0 };
    count.files++;
    count.bytes += bytes.length;
    totals.set(root, count);
    return destination;
  }

  async function save(scope: (typeof scopes)[number], folders: readonly string[], name: string) {
    const path = join(source, scope.path, ...folders, name);
    const info = await named(path);
    if (!info) throw sourceChanged();
    if (!info.isFile() || info.nlink !== 1 || info.size > scope.maxMiB * 1024 * 1024) {
      throw new Error(`旧游戏数据 ${scope.path} 须为大小有效且无硬链接的普通文件。`);
    }
    const bytes = await readSnapshot(path, info, signal);
    const isActive = scope.active(name);
    const root = isActive ? scope.path : archiveRoot(scope.path);
    const destination = await publishFile(root, folders, name, bytes, isActive ? active : archived);
    if (isActive) await validateActive(scope.path, name, bytes, destination);
    files.set(path, info);
  }

  async function scan(scope: (typeof scopes)[number], folders: readonly string[] = []) {
    signal?.throwIfAborted();
    const directory = join(source, scope.path, ...folders);
    if (!await sourceDirectory(directory)) return;
    for (const name of (await readdir(directory)).sort()) {
      signal?.throwIfAborted();
      if (folders.length < scope.nesting) {
        if (numeric.test(name)) await scan(scope, [...folders, name]);
      } else if (name === ".lotus-genshin-gacha-journal.json" && scope.path === "data/gachaJson") {
        throw new Error("原神抽卡目录含未恢复的写入，请在副本中恢复事务后再迁移。");
      } else if (!name.startsWith(".") && name.endsWith(".json")) {
        await save(scope, folders, name);
      }
    }
  }

  async function stageRoleMaterials() {
    const root = join("data", "guides", "material");
    for (const author of legacyRoleMaterials) {
      signal?.throwIfAborted();
      const directory = join(source, "temp", "material", author);
      if (!await sourceDirectory(directory, true)) continue;
      for (const name of (await readdir(directory)).sort()) {
        signal?.throwIfAborted();
        if (!name.endsWith(".jpg") || !safeGuideName(name.slice(0, -4)) || name.startsWith(".")) continue;
        const file = join(directory, name);
        const info = await named(file);
        if (!info) throw sourceChanged();
        if (!info.isFile() || info.nlink !== 1 || !info.size || info.size > roleImageLimit) continue;
        const bytes = await readSnapshot(file, info, signal);
        if (!isGuideImage(bytes)) continue;
        await publishFile(root, [author], name, bytes, active);
        files.set(file, info);
      }
    }
  }

  async function stageNumberedGuides() {
    for (const number of ["1", "2", "3", "4", "5", "6", "7"]) {
      const copied = new Set<string>();
      for (const path of ["temp/strategy", "data/strategy"]) {
        signal?.throwIfAborted();
        const directory = join(source, path, number);
        if (!await sourceDirectory(directory, true)) continue;
        for (const name of (await readdir(directory)).sort()) {
          signal?.throwIfAborted();
          if (copied.has(name) || !name.endsWith(".jpg") || !safeGuideName(name.slice(0, -4)) || name.startsWith(".")) continue;
          const file = join(directory, name);
          const info = await named(file);
          if (!info) throw sourceChanged();
          if (!info.isFile() || info.nlink !== 1 || !info.size || info.size > roleImageLimit) continue;
          const bytes = await readSnapshot(file, info, signal);
          if (!isGuideImage(bytes)) continue;
          await publishFile("data/strategy", [number], name, bytes, active);
          files.set(file, info);
          copied.add(name);
        }
      }
    }
  }

  async function oldGuideConfiguration(relative: string): Promise<unknown> {
    signal?.throwIfAborted();
    const path = join(source, relative);
    if (!await sourceDirectory(dirname(path), true)) return;
    const info = await named(path);
    if (!info?.isFile() || info.nlink !== 1 || info.size > 64 * 1024) return;
    const bytes = await readSnapshot(path, info, signal);
    files.set(path, info);
    try { return Bun.YAML.parse(bytes.toString("utf8")); } catch { return undefined; }
  }

  function configMapping(input: unknown): Record<string, unknown> {
    return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  }

  async function stageGuideSettings() {
    const strategyDirectory = "data/guides/roleGuides";
    const genshin = configMapping(await oldGuideConfiguration("plugins/genshin/config/mys.set.yaml"));
    const sourceNumber = genshin.defaultSource;
    if (typeof sourceNumber === "number" && Number.isInteger(sourceNumber) && genshinStrategySource(sourceNumber)) {
      await publishFile(strategyDirectory, [], "genshin-strategy.json",
        Buffer.from(JSON.stringify({ defaultSource: sourceNumber }) + "\n"), active);
    }

    const strategy = new Map<string, number>();
    for (const folder of ["defSet", "config"]) {
      const values = configMapping(await oldGuideConfiguration(`plugins/ZZZ-Plugin/${folder}/guide.yaml`));
      for (const key of ["default_guide", "max_forward_guides"]) {
        const input = values[key];
        const number = key === "default_guide" && input === "all" ? 0
          : typeof input === "string" && /^\d+$/u.test(input) ? Number(input) : input;
        if (typeof number === "number" && (key === "default_guide" || number > 0) &&
            zzzStrategyOptions.some(({ value }) => value === number)) strategy.set(key, number);
      }
    }
    if (strategy.size) {
      await publishFile(strategyDirectory, [], "zzz-strategy.json",
        Buffer.from(JSON.stringify(Object.fromEntries(strategy)) + "\n"), active);
    }

    const guides: Record<string, unknown> = {};
    async function mora(file: string) {
      return await oldGuideConfiguration(`plugins/mora-plugin/config/user/${file}`) ??
        await oldGuideConfiguration(`plugins/mora-plugin/config/default/${file}`);
    }
    const forward = configMapping(await mora("config.yaml")).forwardMsg;
    if (typeof forward === "boolean" || forward === 0 || forward === 1) guides.forward = Boolean(forward);
    for (const game of Object.keys(guideGames) as GuideGame[]) {
      const input = await mora(guideGames[game].config);
      if (!input || typeof input !== "object" || Array.isArray(input) === (game === "gs")) continue;
      try {
        const authors = parseGuideCollections(game, input);
        guides[guideCollectionKeys[game]] = game === "gs" ? authors : authors.news;
      } catch {}
    }
    if (Object.keys(guides).length) {
      await publishFile("config", [], "guides.yaml", Buffer.from(Bun.YAML.stringify(guides)), active);
    }
  }

  for (const scope of scopes) await scan(scope);
  await stageRoleMaterials();
  await stageNumberedGuides();
  await stageGuideSettings();
  for (const [path, info] of [...dirs, ...files]) {
    signal?.throwIfAborted();
    if (!unchanged(info, await named(path))) throw sourceChanged();
  }
  return { active: [...active.values()], archived: [...archived.values()] };
}
