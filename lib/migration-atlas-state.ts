import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { copyAtlasCandidate } from "../plugins/atlas/assemble-candidate.ts";
import { isAtlasSourceWebp } from "../plugins/atlas/source-transport.ts";
import { prepareAtlasTheme } from "../plugins/atlas/prepare-theme.ts";
import { parseAtlasUpdatePolicy } from "../plugins/atlas/update-policy.ts";
import { parseAtlasSearchLimit } from "../plugins/atlas/search-limit.ts";
import { validateAtlasCandidate } from "../plugins/atlas/validate-candidate.ts";
import { isAtlasChannel } from "./atlas-channel.ts";
import { legacyLotusDirectories } from "./lotus-global-config.ts";
import { withinInstallation } from "./plugins/migration-plan.ts";

const legacyPlugins = legacyLotusDirectories.map(name => join("plugins", name));
const globalPaths = ["config/global.yaml", "config/config/global.yaml"] as const;
const themeRelative = "resources/miao-theme";
const exportRelative = "data/atlas";

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

async function physical(path: string) {
  try {
    const info = await lstat(path);
    if (await realpath(path) !== path || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) {
      throw new Error("图鉴迁移只读取副本内的实体目录和无硬链接普通文件。");
    }
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readStableFile(path: string, limit: number, signal?: AbortSignal) {
  const expected = await physical(path);
  if (!expected) return;
  if (!expected.isFile() || expected.size > limit) throw new Error("图鉴迁移文件大小或类型无效。");
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const same = async () => {
      const actual = await file.stat();
      return actual.dev === expected.dev && actual.ino === expected.ino && actual.size === expected.size &&
        actual.ctimeMs === expected.ctimeMs && actual.mtimeMs === expected.mtimeMs && actual.nlink === 1;
    };
    if (!await same()) throw new Error("旧图鉴文件在读取期间变更。");
    const bytes = Buffer.alloc(expected.size);
    let pos = 0;
    while (pos < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, pos, bytes.length - pos, pos);
      if (!bytesRead) throw new Error("旧图鉴文件在读取期间变更。");
      pos += bytesRead;
    }
    if (!await same() || await realpath(path) !== path) throw new Error("旧图鉴文件在读取期间变更。");
    return bytes;
  } finally {
    await file.close();
  }
}

async function readConfig(path: string, signal?: AbortSignal) {
  const bytes = await readStableFile(path, 1024 * 1024, signal);
  if (!bytes) return;
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("图鉴迁移配置须为有效的 UTF-8 YAML。");
  }
  if (parsed == null) return {};
  const value = record(parsed);
  if (!value) throw new Error("图鉴迁移配置须为 YAML 对象。");
  return value;
}

async function atlasConfig(source: string, signal?: AbortSignal) {
  for (const base of ["", ...legacyPlugins]) {
    for (const relative of globalPaths) {
      const config = await readConfig(join(source, base, relative), signal);
      if (config === undefined) continue;
      if (Object.hasOwn(config, "atlas")) {
        const atlas = record(config.atlas);
        if (!atlas) throw new Error("旧 atlas 配置须为 YAML 对象。");
        return { base, atlas };
      }
      break;
    }
  }
}

function oldCron(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return value === "" ? undefined : value;
  // The fixed old loader passed only the first six fields to node-schedule.
  return value.trim().split(/\s+/u).slice(0, 6).join(" ");
}

function safeArgs(selections: readonly string[]) {
  const pages = new Map<string, string[]>();
  for (const selection of selections) {
    const [game, ...path] = selection.split("/");
    const current = pages.get(game!) ?? [];
    current.push(path.join("/"));
    pages.set(game!, current);
  }
  return ["--page", [...pages].map(([game, current]) => `${game}=${current.join(",")}`).join(";")];
}

function stageConfig(atlas: Record<string, unknown>) {
  const value: Record<string, unknown> = {};
  if (isAtlasChannel(atlas.version_channel)) value.version_channel = atlas.version_channel;
  if (typeof atlas.sync_after_update === "boolean") value.sync_after_update = atlas.sync_after_update;
  if (typeof atlas.sync_gallery === "boolean") value.sync_gallery = atlas.sync_gallery;
  if (typeof atlas.sync_character_gallery === "boolean") value.sync_character_gallery = atlas.sync_character_gallery;
  const searchLimit = parseAtlasSearchLimit(atlas.max_results);
  if (searchLimit !== undefined) value.max_results = searchLimit;
  const auto = record(atlas.auto_update);
  if (auto) {
    value.auto_update = Object.fromEntries([
      ["enable", auto.enable], ["check_cron", oldCron(auto.check_cron)], ["challenge_cron", oldCron(auto.challenge_cron)],
      ["run_on_missing_data", typeof auto.run_on_missing_data === "boolean" ? auto.run_on_missing_data : undefined],
    ].filter(([, configured]) => configured !== undefined));
  }
  const policy = parseAtlasUpdatePolicy({ ...value, update_args: atlas.update_args, challenge_args: atlas.challenge_args });
  if (policy.version.issue || policy.challenge.issue || (atlas.auto_update !== undefined && !auto)) {
    throw new Error("旧图鉴定时任务或分类范围无效，无法安全迁移。");
  }
  for (const [key, task] of [["update_args", policy.version], ["challenge_args", policy.challenge]] as const) {
    const args = atlas[key];
    if (!Array.isArray(args)) continue;
    // Preserve an explicitly empty selection using its original validated scope.
    // An omitted selection keeps the current runtime defaults.
    value[key] = task.selections.length ? safeArgs(task.selections) : args.slice(args[0] === "src/scrape.mjs" ? 1 : 0);
  }
  return value;
}

async function atlasExport(source: string, base: string | undefined, configured: unknown) {
  const value = configured === undefined ? exportRelative : configured;
  if (typeof value !== "string" || !value.trim() || isAbsolute(value) ||
      /[\\\u0000-\u001f]/u.test(value) || value.split("/").some(part => part === "..")) {
    return { status: "external-or-unsupported" } as const;
  }
  if (value === exportRelative) {
    const modern = join(source, exportRelative);
    if ((await physical(join(modern, "data/map.json")))?.isFile()) return { status: "present", path: modern } as const;
  }
  const roots = value === exportRelative ? legacyPlugins : [base ?? ""];
  const found = [];
  for (const relative of roots) {
    const path = resolve(source, relative, value);
    if (!withinInstallation(source, path) || !(await physical(join(path, "data/map.json")))?.isFile()) continue;
    found.push(path);
  }
  if (found.length > 1) throw new Error("迁移副本中有两个旧图鉴导出，请先核定要保留的来源。");
  return found.length ? { status: "present", path: found[0]! } as const : { status: "absent" } as const;
}

async function verifyThemeTree(path: string, signal?: AbortSignal) {
  if (!(await physical(path))?.isDirectory()) return false;
  const queue = [path];
  for (let index = 0; index < queue.length; index++) {
    signal?.throwIfAborted();
    const current = queue[index]!;
    for (const entry of await readdir(current)) {
      const file = join(current, entry);
      if ((await physical(file))?.isDirectory()) queue.push(file);
    }
  }
  await physical(join(dirname(path), "fonts", "MiSans-VF.ttf"));
  return true;
}

const themeIndexes = ["portraits", "relic-parts"] as const;

function indexReference(kind: (typeof themeIndexes)[number], key: string, value: unknown) {
  if (kind === "portraits" && /^gi-[1-9]\d*(?:-\d+)?$/u.test(key) && value === key + ".webp") {
    return { file: value as string, item: value };
  }
  const item = record(value);
  const file = item?.file;
  const name = item?.name;
  if (kind === "relic-parts" && /^sr-[1-9]\d*$/u.test(key) && typeof file === "string" &&
      /^sr-[1-9]\d*-[1-6][.]webp$/u.test(file) && typeof name === "string" && name.trim() && !/[\p{Cc}\p{Cf}]/u.test(name)) {
    return { file, item: { file, name } };
  }
}

async function readThemeIndex(path: string, signal?: AbortSignal) {
  const bytes = await readStableFile(path, 1024 * 1024, signal);
  if (!bytes) return {};
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) ?? {};
  } catch {
    // The renderer falls back to its snapshot when an optional theme index is unreadable.
    return {};
  }
}

async function stageIndexedTheme(source: string, theme: string, signal?: AbortSignal) {
  let copied = 0;
  for (const kind of themeIndexes) {
    const donor = join(source, kind);
    const directory = join(theme, kind);
    const destination = join(directory, "index.json");
    const index = await readThemeIndex(join(donor, "index.json"), signal);
    if (!Object.keys(index).length) continue;
    await physical(directory);
    const original = await readThemeIndex(destination, signal);
    const added: Record<string, unknown> = {};
    const present = new Set<string>();
    for (const [key, value] of Object.entries(index)) {
      signal?.throwIfAborted();
      const reference = indexReference(kind, key, value);
      if (!reference || Object.hasOwn(original, key)) continue;
      const target = join(directory, reference.file);
      if (!present.has(reference.file)) {
        const bytes = await readStableFile(join(donor, reference.file), 8 * 1024 * 1024, signal);
        if (!bytes || !isAtlasSourceWebp(bytes)) continue;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const previous = await readStableFile(target, 8 * 1024 * 1024, signal);
        if (previous && !previous.equals(bytes)) continue;
        if (!previous) {
          await writeFile(target, bytes, { signal, flag: "wx", mode: 0o600 });
          copied++;
        }
        present.add(reference.file);
      }
      added[key] = reference.item;
    }
    if (Object.keys(added).length) {
      await writeFile(destination, JSON.stringify({ ...original, ...added }) + "\n", { signal, mode: 0o600 });
    }
  }
  return copied;
}

/** Stages the recognized local export and only the Atlas settings consumed by the current runtime. */
export async function stageLegacyAtlasState(sourcePath: string, stateDirectory: string, signal?: AbortSignal) {
  const [source, stage] = await Promise.all([realpath(sourcePath), realpath(stateDirectory)]);
  const info = await lstat(stage);
  if (stage !== resolve(stateDirectory) || !info.isDirectory() || (info.mode & 0o077) ||
      withinInstallation(source, stage) || withinInstallation(stage, source)) {
    throw new Error("旧图鉴暂存必须使用独立的私有实体目录。");
  }
  const config = await atlasConfig(source, signal);
  const projected = config ? stageConfig(config.atlas) : undefined;
  const exportRoot = await atlasExport(source, config?.base, config?.atlas.data_root);
  const directory = join(stage, exportRelative);
  let dataset: { readonly status: "absent" | "external-or-unsupported" } |
    { readonly status: "staged"; readonly pages: number; readonly images: number } = { status: "absent" };
  if (exportRoot.status === "present") {
    const data = join(exportRoot.path, "data");
    if (!(await physical(data))?.isDirectory()) throw new Error("旧图鉴导出数据须为实体目录。");
    const validation = await validateAtlasCandidate(data, [], signal);
    if (!validation.ok) throw new Error("旧图鉴导出未通过可复用快照校验。");
    await physical(dirname(directory));
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    const prepared = await copyAtlasCandidate(exportRoot.path, directory, validation.pages, undefined, signal);
    dataset = { status: "staged", pages: prepared.validation.pages.length, images: prepared.imageCount };
  } else dataset = { status: exportRoot.status };
  const stageUrl = pathToFileURL(stage + sep);
  let themeFiles = 0;
  for (const plugin of [...legacyPlugins].reverse()) {
    const donor = join(source, plugin, themeRelative);
    if (!await verifyThemeTree(donor, signal)) continue;
    for (const path of [dirname(directory), directory, join(directory, "theme")]) await physical(path);
    const { copied } = await prepareAtlasTheme(stageUrl, { source: donor, signal });
    themeFiles += copied.length + await stageIndexedTheme(donor, join(directory, "theme"), signal);
  }
  let settings: "absent" | "existing" | "staged" = "absent";
  if (projected) {
    const file = join(stage, globalPaths[0]);
    await physical(dirname(file));
    const current = await readConfig(file, signal) ?? {};
    settings = "existing";
    if (!Object.hasOwn(current, "atlas")) {
      signal?.throwIfAborted();
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, stringify({ ...current, atlas: projected }), { mode: 0o600 });
      settings = "staged";
    }
  }
  return { settings, dataset, themeFiles };
}
