import { join } from "node:path";
import { builtinResourceDirectory } from "./builtin-resources.ts";
import { builtinFontFallback } from "../packages/skia/builtin-fonts.ts";
import { registerGachaThemeFont } from "../packages/skia/gacha-theme-fonts.ts";
const cache = new Map<string, string>();
/** Exact Miao CSS stack: numeric face, original Han/title face, then project fallback. */
export function miaoTemplateFont(title = false, root = builtinResourceDirectory("games/miao")) {
  const key = root + ":" + title;
  if (cache.has(key)) return cache.get(key)!;
  const faces: string[] = [];
  for (const file of ["tttgbnumber.ttf", ...(title ? ["NZBZ.ttf"] : []), "HYWH-65W.ttf"]) {
    try { faces.push(registerGachaThemeFont("MiaoTemplate", join(root, "common/font", file))); } catch {}
  }
  const family = [...faces, builtinFontFallback].join(", ");
  cache.set(key, family);
  return family;
}

export function flowerTemplateFont(title = false) {
  const root = builtinResourceDirectory("games/flower-fonts");
  const key = root + ":" + title;
  if (cache.has(key)) return cache.get(key)!;
  const faces: string[] = [];
  for (const file of ["tttgbnumber.ttf", title ? "HYWH-85W.ttf" : "HYWH-65W.ttf"]) {
    try { faces.push(registerGachaThemeFont("FlowerTemplate", join(root, "font", file))); } catch {}
  }
  const family = [...faces, builtinFontFallback].join(", ");
  cache.set(key, family);
  return family;
}

/** Genshin's original resource templates use the 55W face, distinct from Miao 65W. */
export function genshinTemplateFont() {
  const root = builtinResourceDirectory("games/genshin");
  if (cache.has(root)) return cache.get(root)!;
  const faces: string[] = [];
  for (const file of ["tttgbnumber.ttf", "HYWenHei-55W.ttf"]) {
    try { faces.push(registerGachaThemeFont("GenshinTemplate", join(root, "font", file))); } catch {}
  }
  const family = [...faces, builtinFontFallback].join(", ");
  cache.set(root, family);
  return family;
}
