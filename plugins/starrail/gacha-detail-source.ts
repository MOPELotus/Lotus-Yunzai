import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StarRailGachaDetailOptions } from "./gacha-detail.ts";

const defaultTheme = fileURLToPath(new URL("../../data/starrail/miao-theme", import.meta.url));
const missing = new Set(["ENOENT", "ENOTDIR"]);

export function starRailGachaThemeDirectory() {
  return Bun.env.LOTUS_STAR_RAIL_GACHA_THEME_DIR?.trim() || defaultTheme;
}

function isSegment(value: unknown): value is string {
  return typeof value === "string" && !!value && value !== "." && value !== ".." && !/[\/\\\0]/u.test(value);
}

type ResolveItem = NonNullable<StarRailGachaDetailOptions["resolveItem"]>;
type Item = NonNullable<ReturnType<ResolveItem>>;

async function itemCatalog(root: string, category: "character" | "weapon") {
  const filename = join(root, "meta-sr", category, "data.json");
  const result = new Map<string, Item>();
  try {
    const rows: unknown = JSON.parse(await readFile(filename, "utf8"));
    if (!rows || typeof rows !== "object" || Array.isArray(rows)) return result;
    for (const [id, row] of Object.entries(rows)) {
      if (!/^\d+$/u.test(id) || !row || typeof row !== "object") continue;
      const { name, abbr, type } = row;
      if (!isSegment(name) || (category === "weapon" && !isSegment(type))) continue;
      result.set(name, {
        id: category === "character" ? Number(id) : id,
        name, abbr: name.length > (category === "character" ? 3 : 4) && typeof abbr === "string" && abbr ? abbr : name,
        img: category === "character" ? `/meta-sr/character/${name}/imgs/face.webp` : `meta-sr/weapon/${type}/${name}/icon.webp`,
      });
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && !missing.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  return result;
}

export async function readStarRailGachaItems(root: string): Promise<ResolveItem> {
  const [characters, weapons] = await Promise.all([itemCatalog(root, "character"), itemCatalog(root, "weapon")]);
  return ({ name, item_type }) => (item_type === "角色" ? characters : weapons).get(name);
}
