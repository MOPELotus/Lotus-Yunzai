import { dailyNoteAssets, dailyNoteResourcePath, dailyNoteSourceRevision } from "@lotus-yunzai/skia/daily-note-assets";
import { join } from "node:path";
import { legacyLotusDirectories } from "./lotus-global-config.ts";
import { prepareFixedTheme, type FixedThemeOptions } from "./fixed-theme.ts";

const theme = {
  resourcePath: dailyNoteResourcePath,
  sourceRoots: [dailyNoteResourcePath, ...legacyLotusDirectories.map(name => join("plugins", name, "resources"))],
  raw: `https://raw.githubusercontent.com/MOPELotus/Lotus-ReFactor/${dailyNoteSourceRevision}/resources/`,
  assets: dailyNoteAssets,
};

export function prepareDailyNoteTheme(checkout: URL, options?: FixedThemeOptions) {
  return prepareFixedTheme(checkout, theme, options);
}
