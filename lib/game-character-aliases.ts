import { linkSync, renameSync } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcquireRoleArchiveLock } from "@lotus-yunzai/storage";
import { readMigrationSourceFile } from "./migration-files.ts";

type Game = "gs" | "sr";
type Preset = Map<string, Set<string>>;
const games = ["gs", "sr"] as const;
const gameLabels = { gs: "原神", sr: "星铁" };
const rootDirectory = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const maxBytes = 64 * 1024;

export function characterAliasKey(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[\s·・•]/gu, "");
}

function validAlias(value: string) {
  const normalized = value.normalize("NFKC");
  return /^[\p{L}\p{M}\p{N}·・•_.&★-]{1,24}$/u.test(normalized) && /\p{L}/u.test(normalized);
}

function parseRow(line: string) {
  const m = /^\s*([^:：\p{Cc}]+?)\s*[:：](.*)$/u.exec(line);
  if (!m || /^\s*[#;]/u.test(line)) return;
  const role = m[1]!.trim();
  const labels = m[2]!.split(/[,，]/u).map(value => value.trim()).filter(Boolean);
  if (role && labels.length) return { role, labels };
}

function canonicalRole(preset: Preset, name: string) {
  const alternatives = preset.get(characterAliasKey(name));
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

async function snapshot(root: string, game: Game) {
  const { target, sources } = files(root, game);
  for (const file of [target, ...sources]) {
    const stored = await readMigrationSourceFile(root, file, maxBytes);
    if (!stored) continue;
    return { file, stored, content: new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes) };
  }
}

export async function readGameCharacterAliases(game: Game, root = rootDirectory) {
  try {
    const source = await snapshot(root, game);
    return source ? parseGameCharacterAliases(await readPreset(game), source.content) : new Map<string, string>();
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
  const index: Preset = new Map();
  for (const [role, aliases] of names) {
    for (const term of [role, ...aliases.split(",")].filter(Boolean)) {
      const key = characterAliasKey(term);
      const targets = index.get(key) ?? new Set<string>();
      targets.add(role);
      index.set(key, targets);
    }
  }
  return index;
}

const presetTables: Partial<Record<Game, Promise<Preset>>> = {};

function readPreset(game: Game): Promise<Preset> {
  return presetTables[game] ??= (game === "gs"
    ? import("../plugins/genshin/panel/miao/character-alias.ts").then(({ alias }) => buildPreset(Object.entries(alias)))
    : Promise.all([
      import("../plugins/starrail/panel-theme/character-alias.ts"), import("../plugins/starrail/challenge-character-names.json"),
    ]).then(([{ alias }, { default: characters }]) => buildPreset([
      ...Object.entries(alias), ...Object.values(characters).map(name => [name, ""] as const),
    ]))).catch(() => new Map());
}
type AliasContext = {
  readonly user_id?: number;
  readonly isBotMaster?: (user: number) => boolean;
  readonly isDelegated?: boolean;
};
type AliasCommand = NonNullable<ReturnType<typeof matchGameCharacterAliasCommand>>;

export function createGameCharacterAliasCommands(lockFile: AcquireRoleArchiveLock, signal: AbortSignal, root = rootDirectory) {
  let atlas: Promise<typeof import("../plugins/atlas/catalog.ts") | undefined> | undefined;
  return async (command: AliasCommand, context: AliasContext) => {
    if (signal.aborted || context.isDelegated) return;
    if (command.type === "help") {
      return "角色别名支持 #别名原神设置 角色名 别名、*别名设置 角色名 别名、#别名删除 别名和 #别名列表。\nhttps://www.lotusshared.cn/yunzai/";
    }
    const chosen = command.game ? [command.game] : games;
    const owners = () => !signal.aborted && !context.isDelegated &&
      typeof context.user_id === "number" && context.isBotMaster?.(context.user_id) === true;
    if (command.type !== "list" && !owners()) return "仅限本机器人主人修改角色别名。";
    if (command.type !== "list" && !validAlias(command.alias)) return "别名须为 1 到 24 个文字、数字或常用连接符，且不能是纯数字。";
    try {
      const records = async () => new Map(await Promise.all(chosen.map(async game => [game, await snapshot(root, game)] as const)));
      if (command.type === "list") {
        const entries = await records();
        return [...entries].map(([game, source]) => {
          const lines = (source?.content ?? "").split(/\r?\n/u).filter(line => parseRow(line));
          return lines.length ? `【${gameLabels[game]}自定义别名】\n${lines.join("\n").slice(0, 3_000)}` : `暂无${gameLabels[game]}自定义别名。`;
        }).join("\n");
      }
      const directory = dirname(files(root, "gs").target);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (await realpath(directory) !== directory) return "角色别名配置目录不可用。";
      const lock = await lockFile(join(directory, ".aliases.sqlite"), "角色别名");
      try {
        const entries = await records();
        const atlasModule = command.type === "set" ? await (atlas ??= import("../plugins/atlas/catalog.ts").catch(() => undefined)) : undefined;
        const catalog = await atlasModule?.createAtlasRuntimeCatalog(join(root, "data", "atlas"), Bun.env.LOTUS_ATLAS_DATA_DIR)
          .read().catch(() => undefined);
        const presets = new Map(await Promise.all(chosen.map(async game => [game, await readPreset(game)] as const)));
        const lookups = new Map([...entries].map(([game, source]) => [game, parseGameCharacterAliases(presets.get(game)!, source?.content ?? "")]));
        function names(game: Game, value: string) {
          const key = characterAliasKey(value);
          const table = presets.get(game)!;
          const preset = table.get(key);
          const current = lookups.get(game)?.get(key);
          const indexed = catalog ? atlasModule!.findTraditionalEntries(catalog, value, game === "gs" ? "gi" : "hsr", "character")
            .filter(({ score }) => score >= 2.5).map(({ entry }) => entry.name) : [];
          const exact = [...(preset ?? []), ...indexed].find(role => characterAliasKey(role) === key);
          return exact ? new Set([exact]) : new Set([...(preset ?? []), ...indexed, ...(current ? [current] : [])]
            .map(role => canonicalRole(table, role)));
        }
        const key = characterAliasKey(command.alias);
        const candidates = chosen.flatMap(game => command.type === "set"
          ? [...names(game, command.role)].map(role => ({ game, role }))
          : lookups.get(game)?.has(key) ? [{ game, role: lookups.get(game)!.get(key)! }] : []);
        if (candidates.length !== 1) return candidates.length
          ? "名称有多个匹配，请指定游戏或使用角色标准名。" : command.type === "set" ? "未找到该角色。" : "未找到可删除的自定义别名。";
        const { game, role } = candidates[0]!;
        const source = entries.get(game);
        const target = files(root, game).target;
        let lines = (source?.content ?? "").split(/\r?\n/u);
        if (lines.at(-1) === "") lines.pop();
        if (command.type === "set") {
          if (names(game, command.alias).size || lines.some(line =>
            parseRow(line)?.labels.some(label => characterAliasKey(label) === key))) return `别名 ${command.alias} 已存在。`;
          lines.push(`${role}：${command.alias}`);
        } else {
          lines = lines.flatMap(line => {
            const row = parseRow(line);
            if (!row || canonicalRole(presets.get(game)!, row.role) !== role) return [line];
            const remaining = row.labels.filter(label => characterAliasKey(label) !== key);
            if (remaining.length === row.labels.length) return [line];
            return remaining.length ? [`${row.role}：${remaining.join("，")}`] : [];
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
          const latest = await snapshot(root, game);
          if (!owners()) return "仅限本机器人主人修改角色别名。";
          if (latest?.file !== source?.file || latest?.stored.dev !== source?.stored.dev ||
              latest?.stored.ino !== source?.stored.ino || latest?.content !== source?.content) return "别名已变更，请重新操作。";
          if (latest?.file === target) renameSync(temporary, target);
          else linkSync(temporary, target);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
        return command.type === "set" ? `${role} 的别名 ${command.alias} 已添加。` : `别名 ${command.alias} 已删除。`;
      } finally {
        lock.close();
      }
    } catch {
      return signal.aborted ? undefined : "角色别名暂时无法读取或更新。";
    }
  };
}
