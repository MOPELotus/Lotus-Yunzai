import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMiaoArrayExport } from "@lotus-yunzai/gacha/miao-data";
import { resolveGenshinDetailPool, type GenshinGachaDetailOptions, type GenshinGachaDetailPeriod } from "./gacha-detail.ts";
import type { GenshinPreviousGacha } from "./gacha-history.ts";
import type { GenshinGachaVersionPeriod } from "./gacha-version.ts";

const defaultTheme = fileURLToPath(new URL("../../data/genshin/miao-theme", import.meta.url));
const weaponTypes = ["sword", "claymore", "polearm", "bow", "catalyst"] as const;
type Resolver = NonNullable<GenshinGachaDetailOptions["resolveItem"]>;
type Item = NonNullable<ReturnType<Resolver>>;

export function genshinGachaThemeDirectory() {
  return Bun.env.LOTUS_GENSHIN_GACHA_THEME_DIR?.trim() || defaultTheme;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeSegment(value: unknown): value is string {
  return typeof value === "string" && !!value && value !== "." && value !== ".." && !/[\/\\\0]/u.test(value);
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return "";
  }
}

async function readJson(path: string): Promise<unknown> {
  const source = await readOptional(path);
  if (source) {
    try { return JSON.parse(source); }
    catch { return undefined; }
  }
}

function metadata(id: unknown, name: unknown, abbr: unknown, limit: number): Omit<Item, "img"> | undefined {
  if (typeof id !== "string" && typeof id !== "number") return;
  const numeric = Number(id);
  if (!safeSegment(name) || !Number.isSafeInteger(numeric) || numeric <= 0) return;
  return { id, name, abbr: typeof abbr === "string" && abbr && name.length > limit ? abbr : name };
}

async function readCharacters(root: string) {
  const rows = record(await readJson(join(root, "meta-gs", "character", "data.json")));
  const result = new Map<string, Item>();
  for (const [id, value] of Object.entries(rows ?? {})) {
    const row = record(value);
    const item = row && metadata(Number(id), row.name, row.abbr, 3);
    if (item) result.set(item.name, { ...item, img: `/meta-gs/character/${item.name}/imgs/face.webp` });
  }
  return result;
}

async function readWeapons(root: string, records: GenshinPreviousGacha) {
  const names = new Set(Object.values(records).flatMap((rows) => (Array.isArray(rows) ? rows : []).flatMap((value) => {
    const row = record(value);
    return row?.item_type === "武器" && safeSegment(row.name) ? [row.name] : [];
  })));
  const items = await Promise.all(weaponTypes.map(async (type) => {
    const directory = join(root, "meta-gs", "weapon", type);
    const children = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      return [];
    });
    return Promise.all(children.filter((name) => names.has(name)).map(async (name) => {
      const row = record(await readJson(join(directory, name, "data.json")));
      const item = row && metadata(row.id, row.name, row.abbr, 4);
      if (item?.name === name) return { ...item, img: `meta-gs/weapon/${type}/${name}/icon.webp` };
    }));
  }));
  return new Map(items.flat().filter((item) => item !== undefined).map((item) => [item.name, item]));
}

function period(value: unknown): value is GenshinGachaDetailPeriod {
  const row = record(value);
  return typeof row?.from === "string" && typeof row.to === "string" &&
    Array.isArray(row.char5) && row.char5.every((name) => typeof name === "string") &&
    Array.isArray(row.weapon5) && row.weapon5.every((name) => typeof name === "string");
}

function versionPeriod(entry: GenshinGachaDetailPeriod): entry is GenshinGachaVersionPeriod {
  return "version" in entry && typeof entry.version === "string" && "half" in entry && typeof entry.half === "string";
}

export async function readGenshinGachaSources(root: string, records: GenshinPreviousGacha) {
  const [characters, weapons, calendar] = await Promise.all([
    readCharacters(root), readWeapons(root, records), readOptional(join(root, "meta-gs", "info", "pool.js")),
  ]);
  const resolveItem: Resolver = ({ name, itemType }) => (itemType === "char" ? characters : weapons).get(name);
  const named = (entry: GenshinGachaVersionPeriod): GenshinGachaVersionPeriod => ({
    ...entry, name: entry.char5.map((name) => characters.get(name)?.abbr ?? name).join(" / "),
  });
  const regular = readMiaoArrayExport(calendar, "poolDetail").filter(period);
  const mixed = readMiaoArrayExport(calendar, "mixPoolDetail").filter(period);
  return {
    resolveItem,
    schedule: regular.filter(versionPeriod).map(named),
    mixedSchedule: mixed.filter(versionPeriod).map(named),
    resolvePool: resolveGenshinDetailPool(regular, mixed),
  };
}
