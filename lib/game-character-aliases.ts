import { linkSync, renameSync } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AcquireRoleArchiveLock } from "@lotus-yunzai/storage";
import { parse } from "yaml";
import { readOptionalLocalConfig } from "./config.ts";
import { readMigrationSourceFile } from "./migration-files.ts";

export type AliasGame = "gs" | "sr";
type Game = AliasGame;
type Preset = { matches: Map<string, Set<string>>; displays: Map<string, string[]> };
const games = ["gs", "sr"] as const;
const gameLabels = { gs: "原神", sr: "星铁" };
const rootDirectory = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const maxBytes = 64 * 1024;
const legacyDone = "# 已导入旧角色昵称";
const independentDone = "# 已导入旧星铁角色别名";
const legacyPrefix = "# 旧角色昵称 ";

export function characterAliasKey(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[\s·・•]/gu, "");
}

export function validCharacterAlias(value: string) {
  const normalized = value.normalize("NFKC");
  return /^[\p{L}\p{M}\p{N}·・•_.&★-]{1,24}$/u.test(normalized) && /\p{L}/u.test(normalized);
}

function parseRow(line: string) {
  const legacy = line.startsWith(legacyPrefix);
  const input = legacy ? line.slice(legacyPrefix.length) : line;
  const m = /^\s*([^:：\p{Cc}]+?)\s*[:：](.*)$/u.exec(input);
  if (!m || /^\s*[#;]/u.test(input)) return;
  const role = m[1]!.trim();
  const labels = m[2]!.split(/[,，]/u).map(value => value.trim()).filter(Boolean);
  if (role && labels.length) return { role, labels, legacy };
}

function canonicalRole(preset: Preset, name: string) {
  const alternatives = preset.matches.get(characterAliasKey(name));
  return [...(alternatives ?? [])].find(role => characterAliasKey(role) === characterAliasKey(name)) ??
    (alternatives?.size === 1 ? [...alternatives][0]! : name);
}

function parseGameCharacterAliases(preset: Preset, content: string) {
  const roles = new Map<string, Set<string>>();
  for (const line of content.split(/\r?\n/u)) {
    const row = parseRow(line);
    if (!row) continue;
    const role = canonicalRole(preset, row.role);
    for (const label of row.labels) {
      const key = characterAliasKey(label);
      if (!key || /^\p{N}+$/u.test(key)) continue;
      const names = roles.get(key) ?? new Set<string>();
      names.add(role);
      roles.set(key, names);
    }
  }
  return new Map([...roles].flatMap(([key, names]) => names.size === 1 ? [[key, [...names][0]!] as const] : []));
}

function files(root: string, game: Game) {
  const key = `config/alias_${game}.cfg`;
  return {
    target: join(root, "config", "character-aliases", `alias_${game}.cfg`),
    sources: [join(root, "plugins/miao-plugin", key), join(root, "backup/plugins/miao-plugin", key)],
  };
}

async function firstAliasFile(root: string, candidates: string[]) {
  for (const file of candidates) {
    const stored = await readMigrationSourceFile(root, file, maxBytes);
    if (!stored) continue;
    return { file, stored, content: new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes) };
  }
}

function legacyConfigs(root: string, filename: string) {
  return ["plugins/genshin/config", "backup/plugins/genshin/config"].map(directory => join(root, directory, filename));
}

function mapping(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function yamlMapping(source?: Awaited<ReturnType<typeof firstAliasFile>>) {
  return source && mapping(parse(source.content, { maxAliasCount: 0 }));
}

async function independentStarRailSetting(root: string, filename: string) {
  for (const location of ["plugins", "backup/plugins"]) {
    const base = join(root, location, "StarRail-plugin");
    const [local, defaults] = await Promise.all([
      firstAliasFile(root, [join(base, "config", filename)]),
      firstAliasFile(root, [join(base, "defSet", filename)]),
    ]);
    if (local || defaults) {
      const configured = yamlMapping(local);
      const bundled = yamlMapping(defaults);
      if (!configured && !bundled) throw new TypeError("旧星铁设置文件应为 YAML 映射。");
      return { ...bundled, ...configured };
    }
  }
}

export function validLegacyCharacterAliasMode(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2;
}

export async function readLegacyCharacterAliasMode(game: Game, root = rootDirectory) {
  if (game === "sr") {
    const global = await readOptionalLocalConfig(pathToFileURL(root.endsWith("/") ? root : root + "/"), "global");
    const current = mapping(global?.starrail)?.legacy_alias_group_permission;
    if (current !== undefined) return validLegacyCharacterAliasMode(current) ? current : 2;
  }
  const independent = game === "sr" ? await independentStarRailSetting(root, "gachaHelp.yaml") : undefined;
  if (game === "sr" && !independent) {
    const managed = await firstAliasFile(root, [files(root, game).target]);
    if ((managed && snapshotLines(managed.content).includes(independentDone)) || await independentStarRailSetting(root, "alias.yaml")) return 2;
  }
  const config = independent ?? yamlMapping(await firstAliasFile(root, legacyConfigs(root, "mys.set.yaml")));
  const mode = config?.abbrSetAuth;
  return mode === 0 || mode === "0" ? 0 : mode === 1 || mode === "1" ? 1 : 2;
}

function snapshotLines(content: string) {
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function yamlAliasRows(raw: Record<string, unknown>, preset: Preset) {
  return Object.entries(raw).flatMap(([name, entries]) => {
    const role = canonicalRole(preset, name);
    if (!preset.displays.has(role) || !Array.isArray(entries)) return [];
    const labels = [...new Set(entries.filter((label): label is string => typeof label === "string" && validCharacterAlias(label)))];
    return labels.length ? [{ role, labels }] : [];
  });
}

function independentAliasRows(raw: Record<string, unknown>, preset: Preset, existing: readonly string[], legacyPreset?: Preset) {
  const reserved = new Set(existing.flatMap(line => parseRow(line)?.labels.map(characterAliasKey) ?? []));
  const rows = yamlAliasRows(raw, preset);
  const candidates = new Map<string, { role: string; label: string }>();
  const conflicts = new Set<string>();
  for (const { role, labels } of rows) {
    for (const label of labels) {
      const key = characterAliasKey(label);
      if (reserved.has(key) || preset.matches.has(key) || legacyPreset?.matches.has(key)) continue;
      const previous = candidates.get(key);
      if (previous && previous.role !== role) conflicts.add(key);
      if (!previous) candidates.set(key, { role, label });
    }
  }
  const unique = new Map<string, string[]>();
  for (const [key, { role, label }] of candidates) {
    if (conflicts.has(key)) continue;
    const labels = unique.get(role) ?? [];
    labels.push(label);
    unique.set(role, labels);
  }
  return [...unique].map(([role, labels]) => `${legacyPrefix}${role}：${labels.join("，")}`);
}

async function snapshot(root: string, game: Game) {
  const { target, sources } = files(root, game);
  const base = await firstAliasFile(root, [target, ...sources]);
  const content = base?.content ?? "";
  const lines = snapshotLines(content);
  const managed = base?.file === target;
  const legacy = managed && lines.includes(legacyDone) ? undefined
    : await firstAliasFile(root, legacyConfigs(root, "role.name.yaml"))
      .then(source => ({ source, aliases: yamlMapping(source) })).catch(() => undefined);
  const generic = legacy?.aliases;
  const independent = game !== "sr" || (managed && lines.includes(independentDone))
    ? undefined : await independentStarRailSetting(root, "alias.yaml").catch(() => undefined);
  if (!generic && !independent) return { base, legacy: legacy?.source, content };
  const preset = await readPreset(game);
  if (generic) {
    const imported = yamlAliasRows(generic, preset).map(({ role, labels }) => `${legacyPrefix}${role}：${labels.join("，")}`);
    lines.push(legacyDone, ...imported);
  }
  if (independent) {
    const legacyPreset = await readLegacyPreset(root, game, preset).catch(() => undefined);
    lines.push(independentDone, ...independentAliasRows(independent, preset, lines, legacyPreset));
  }
  return { base, legacy: legacy?.source, content: [...lines, ""].join("\n") };
}

export async function readGameCharacterAliases(game: Game, root = rootDirectory) {
  try {
    const source = await snapshot(root, game);
    return source.content ? parseGameCharacterAliases(await readPreset(game), source.content) : new Map<string, string>();
  } catch {
    return new Map<string, string>();
  }
}

export function matchGameCharacterAliasCommand(message: string) {
  if (message.length > 160) return;
  const m = /^(#(?:原神|星铁|崩铁)?|\*)\s*别名(?:(原神|星铁|崩铁))?(设置|删除|列表|帮助)?(?:\s+(.+))?$/u.exec(message);
  if (!m) return;
  const [, prefix, marker, operation, args] = m;
  const selected = marker ?? (prefix === "*" ? "星铁" : prefix!.slice(1));
  const game: Game | undefined = selected === "原神" ? "gs" : selected ? "sr" : undefined;
  const parts = args?.trim().split(/\s+/u) ?? [];
  if (operation === "设置" && parts.length === 2) return { game, type: "set", role: parts[0]!, alias: parts[1]! } as const;
  if (operation === "删除" && parts.length === 1) return { game, type: "delete", alias: parts[0]! } as const;
  if (operation === "列表" && !parts.length) return { game, type: "list" } as const;
  return { game, type: "help" } as const;
}

function buildPreset(names: readonly (readonly [string, string])[]) {
  const matches = new Map<string, Set<string>>();
  const displays = new Map<string, string[]>();
  for (const [role, aliases] of names) {
    for (const term of [role, ...aliases.split(",")].filter(Boolean)) {
      const key = characterAliasKey(term);
      const targets = matches.get(key) ?? new Set<string>();
      targets.add(role);
      matches.set(key, targets);
      const display = displays.get(role) ?? [];
      if (!display.includes(term)) display.push(term);
      displays.set(role, display);
    }
  }
  return { matches, displays };
}

async function readLegacyPreset(root: string, game: Game, current: Preset) {
  const filename = game === "gs" ? "name.yaml" : "sr_name.yaml";
  const candidates = ["plugins/genshin/defSet/role", "backup/plugins/genshin/defSet/role"]
    .map(directory => join(root, directory, filename));
  const source = await firstAliasFile(root, candidates);
  const raw: unknown = source && parse(source.content, { maxAliasCount: 0 });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const names = Object.values(raw).flatMap(entries => {
    if (!Array.isArray(entries) || typeof entries[0] !== "string") return [];
    const role = canonicalRole(current, entries[0]);
    if (!current.displays.has(role)) return [];
    const labels = entries.filter((value): value is string => typeof value === "string" && /^[^,\p{Cc}]{1,48}$/u.test(value));
    return [[role, labels.join(",")] as const];
  });
  return buildPreset(names);
}

const presetTables: Partial<Record<Game, Promise<Preset>>> = {};

function readPreset(game: Game): Promise<Preset> {
  return presetTables[game] ??= (game === "gs"
    ? import("../plugins/genshin/panel/miao/character-alias.ts").then(({ alias }) => buildPreset(Object.entries(alias)))
    : Promise.all([
      import("../plugins/starrail/panel-theme/character-alias.ts"), import("../plugins/starrail/challenge-character-names.json"),
    ]).then(([{ alias }, { default: characters }]) => buildPreset([
      ...Object.entries(alias), ...Object.values(characters).map(name => [name, ""] as const),
    ]))).catch(() => ({ matches: new Map(), displays: new Map() }));
}
type AliasContext = {
  readonly user_id?: number;
  readonly isBotMaster?: (user: number) => boolean;
  readonly isDelegated?: boolean;
};
type AliasCommand = NonNullable<ReturnType<typeof matchGameCharacterAliasCommand>>;

type LegacyWrite =
  | { game: Game; type: "legacy-set"; role: string; aliases: readonly string[] }
  | { game: Game; type: "legacy-delete"; alias: string };
type LegacyAccess = { permitted(): Promise<boolean>; active(): boolean };

function sameSource(left?: Awaited<ReturnType<typeof firstAliasFile>>, right?: Awaited<ReturnType<typeof firstAliasFile>>) {
  return left?.file === right?.file && left?.stored.dev === right?.stored.dev &&
    left?.stored.ino === right?.stored.ino && left?.content === right?.content;
}

export function createGameCharacterAliasManager(lockFile: AcquireRoleArchiveLock, signal: AbortSignal, root = rootDirectory) {
  let atlas: Promise<typeof import("../plugins/atlas/catalog.ts") | undefined> | undefined;
  async function lookup(chosen: readonly Game[], withCatalog: boolean, withLegacy = false) {
    const entries = new Map(await Promise.all(chosen.map(async game => [game, await snapshot(root, game)] as const)));
    const presets = new Map(await Promise.all(chosen.map(async game => [game, await readPreset(game)] as const)));
    const legacyPresets = new Map(await Promise.all(withLegacy ? chosen.map(async game =>
      [game, await readLegacyPreset(root, game, presets.get(game)!).catch(() => undefined)] as const) : []));
    const lookups = new Map([...entries].map(([game, source]) => [game, parseGameCharacterAliases(presets.get(game)!, source.content)]));
    const atlasModule = withCatalog ? await (atlas ??= import("../plugins/atlas/catalog.ts").catch(() => undefined)) : undefined;
    const catalog = await atlasModule?.createAtlasRuntimeCatalog(join(root, "data", "atlas"), Bun.env.LOTUS_ATLAS_DATA_DIR)
      .read().catch(() => undefined);
    function names(game: Game, value: string) {
      const key = characterAliasKey(value);
      const table = presets.get(game)!;
      const preset = table.matches.get(key);
      const original = legacyPresets.get(game)?.matches.get(key);
      const current = lookups.get(game)?.get(key);
      const indexed = catalog ? atlasModule!.findTraditionalEntries(catalog, value, game === "gs" ? "gi" : "hsr", "character")
        .filter(({ score }) => score >= 2.5).map(({ entry }) => entry.name) : [];
      const exact = [...(preset ?? []), ...indexed].find(role => characterAliasKey(role) === key);
      return exact ? new Set([exact]) : new Set([...(preset ?? original ?? []), ...indexed, ...(current ? [current] : [])]
        .map(role => canonicalRole(table, role)));
    }
    return { entries, presets, legacyPresets, lookups, names };
  }

  async function find(game: Game, name: string) {
    const { names, presets, legacyPresets, entries } = await lookup([game], true, true);
    const roles = [...names(game, name)];
    if (roles.length !== 1) return;
    const role = roles[0]!;
    const stored = snapshotLines(entries.get(game)!.content).flatMap(line => {
      const row = parseRow(line);
      return row && canonicalRole(presets.get(game)!, row.role) === role ? row.labels : [];
    });
    return { role, aliases: [...new Set([...(presets.get(game)!.displays.get(role) ?? [role]),
      ...(legacyPresets.get(game)?.displays.get(role) ?? []), ...stored])] };
  }

  async function run(command: AliasCommand | LegacyWrite, context: AliasContext, legacyAccess?: LegacyAccess) {
    if (signal.aborted || context.isDelegated) return;
    if (command.type === "help") {
      return "角色别名支持 #别名原神设置 角色名 别名、*别名设置 角色名 别名、#别名删除 别名和 #别名列表。\nhttps://www.lotusshared.cn/yunzai/";
    }
    const chosen = command.game ? [command.game] : games;
    const owner = () => !signal.aborted && !context.isDelegated &&
      typeof context.user_id === "number" && context.isBotMaster?.(context.user_id) === true;
    const legacy = command.type === "legacy-set" || command.type === "legacy-delete";
    const permitted = () => legacy ? legacyAccess?.permitted() : owner();
    const stillActive = () => legacy ? legacyAccess?.active() : owner();
    const denied = legacy ? "暂无权限修改角色别名。" : "仅限本机器人主人修改角色别名。";
    try {
      if (command.type === "list") {
        const entries = await Promise.all(chosen.map(async game => [game, await snapshot(root, game)] as const));
        return entries.map(([game, source]) => {
          const lines = snapshotLines(source.content).flatMap(line => {
            const row = parseRow(line);
            return row ? [`${row.role}：${row.labels.join("，")}`] : [];
          });
          return lines.length ? `【${gameLabels[game]}自定义别名】\n${lines.join("\n").slice(0, 3_000)}` : `暂无${gameLabels[game]}自定义别名。`;
        }).join("\n");
      }
      if (!await permitted() || signal.aborted) return denied;
      const setting = command.type === "set" || command.type === "legacy-set";
      const requested = command.type === "legacy-set" ? command.aliases : [command.alias];
      if (!requested.length || requested.some(alias => !validCharacterAlias(alias))) {
        return "别名须为 1 到 24 个文字、数字或常用连接符，且不能是纯数字。";
      }
      const directory = dirname(files(root, "gs").target);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (await realpath(directory) !== directory) return "角色别名配置目录不可用。";
      const lock = await lockFile(join(directory, ".aliases.sqlite"), "角色别名");
      try {
        const { entries, presets, legacyPresets, lookups, names } = await lookup(chosen, setting, legacy);
        const key = characterAliasKey(requested[0]!);
        const candidates = chosen.flatMap(game => setting
          ? [...names(game, command.role)].map(role => ({ game, role }))
          : lookups.get(game)?.has(key) ? [{ game, role: lookups.get(game)!.get(key)! }] : []);
        if (!setting && legacy && chosen.some(game =>
          presets.get(game)!.matches.has(key) || legacyPresets.get(game)?.matches.has(key))) return "默认别名设置，不能删除。";
        if (candidates.length !== 1) return candidates.length
          ? "名称有多个匹配，请指定游戏或使用角色标准名。" : setting ? "未找到该角色。" : "未找到可删除的自定义别名。";
        const { game, role } = candidates[0]!;
        const source = entries.get(game)!;
        const target = files(root, game).target;
        let lines = snapshotLines(source.content);
        const added: string[] = [];
        if (setting) {
          const occupied = new Set(lines.flatMap(line => parseRow(line)?.labels.map(characterAliasKey) ?? []));
          for (const alias of requested) {
            const normalized = characterAliasKey(alias);
            if (occupied.has(normalized) || names(game, alias).size) continue;
            occupied.add(normalized);
            added.push(alias);
          }
          if (!added.length) return legacy ? "设置失败：别名错误或已存在。" : `别名 ${requested[0]} 已存在。`;
          lines.push(`${legacy ? legacyPrefix : ""}${role}：${added.join("，")}`);
        } else {
          if (presets.get(game)!.matches.has(key)) return "默认别名设置，不能删除。";
          const rows = lines.map(parseRow);
          if (legacy && !owner() && rows.some(row => row && !row.legacy && row.labels.some(label => characterAliasKey(label) === key))) {
            return "该别名仅限本机器人主人删除。";
          }
          lines = lines.flatMap((line, index) => {
            const row = rows[index];
            if (!row || canonicalRole(presets.get(game)!, row.role) !== role) return [line];
            const remaining = row.labels.filter(label => characterAliasKey(label) !== key);
            if (remaining.length === row.labels.length) return [line];
            return remaining.length ? [`${row.legacy ? legacyPrefix : ""}${row.role}：${remaining.join("，")}`] : [];
          });
        }
        const content = lines.length ? lines.join("\n") + "\n" : "";
        if (Buffer.byteLength(content) > maxBytes) return "角色别名配置已达到大小上限。";
        const staging = await mkdtemp(join(directory, ".aliases-"));
        try {
          const temporary = join(staging, "next.cfg");
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(content, "utf8");
            await file.sync();
          } finally {
            await file.close();
          }
          if (!await permitted() || signal.aborted) return denied;
          const latest = await snapshot(root, game);
          if (signal.aborted || !stillActive()) return denied;
          if (!sameSource(latest.base, source.base) || !sameSource(latest.legacy, source.legacy) || latest.content !== source.content) {
            return "别名已变更，请重新操作。";
          }
          if (latest.base?.file === target) renameSync(temporary, target);
          else linkSync(temporary, target);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
        if (!setting) return legacy ? `删除${role}别名成功：${requested[0]}` : `别名 ${requested[0]} 已删除。`;
        return legacy ? `设置别名成功：${added.join("、")}` : `${role} 的别名 ${added[0]} 已添加。`;
      } finally {
        lock.close();
      }
    } catch {
      return signal.aborted ? undefined : "角色别名暂时无法读取或更新。";
    }
  }

  return { run, find };
}

export function createGameCharacterAliasCommands(lockFile: AcquireRoleArchiveLock, signal: AbortSignal, root = rootDirectory) {
  return createGameCharacterAliasManager(lockFile, signal, root).run;
}
