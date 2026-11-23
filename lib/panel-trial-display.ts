import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { legacyArkTrialFields, readLegacyArkTrialSettings } from "./legacy-ark-trial-settings.ts";
import { readOptionalLocalConfig } from "./config.ts";

export const trialTitleModes = [0, 1, 2] as const;
export type TrialTitleMode = (typeof trialTitleModes)[number];

export function isTrialTitleMode(value: unknown): value is TrialTitleMode {
  return trialTitleModes.some(mode => mode === value);
}

export function panelTrialConfigSection(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
}

export async function readPanelTrialDisplay(root: URL) {
  const config = await readOptionalLocalConfig(root, "global");
  const settings = panelTrialConfigSection(config?.panel_trial);
  const fields = Object.hasOwn(config ?? {}, "panel_trial") && !settings ? [] :
    legacyArkTrialFields.filter(([, field]) => !Object.hasOwn(settings ?? {}, field));
  const directory = fileURLToPath(root);
  let legacy: Awaited<ReturnType<typeof readLegacyArkTrialSettings>> | undefined;
  if (fields.length) {
    for (const base of ["plugins", "backup/plugins"]) {
      legacy = await readLegacyArkTrialSettings(directory, join(directory, base, "ark-plugin/config/cfg.js"), fields)
        .catch(() => undefined);
      if (legacy?.size) break;
    }
  }
  const currentDifference = settings?.show_difference ?? legacy?.get("profileChangeDiff");
  const mode = settings?.long_title ?? legacy?.get("DealLongDmgTitle");
  const showDifference = currentDifference !== false;
  const longTitle = isTrialTitleMode(mode) ? mode : 1;
  return { showDifference, longTitle } as const;
}

const legacyTitleLimit = 20;
function legacyTitleUnit(character: string) {
  return character === "1" || character === "(" || character === ")" ? 0.5 : 1;
}

function withinLegacyBudget(title: string) {
  let width = 0;
  for (const character of title) {
    width += legacyTitleUnit(character);
    if (width > legacyTitleLimit) return false;
  }
  return true;
}

export function trialDamageTitleLines(title: string, mode?: TrialTitleMode,
  fits: (title: string) => boolean = withinLegacyBudget): readonly string[] {
  if (!mode) return [title];
  const trimmed = title.trim();

  if (mode === 1) {
    let width = 0, length = 0;
    for (const character of trimmed) {
      width += legacyTitleUnit(character);
      if (width > legacyTitleLimit) return [trimmed.slice(0, length) + "..."];
      length += character.length;
    }
    return [trimmed];
  }

  let line = "";
  const lines: string[] = [];
  for (const character of trimmed) {
    if (line && !fits(line + character)) {
      lines.push(line);
      line = "";
    }
    line += character;
  }
  return lines.length ? [...lines, line] : [title];
}

export const trialDamageTitleLineHeight = 18;

export function layoutTrialDamageTitles(rows: readonly { readonly title: string }[], rowHeight: number, mode?: TrialTitleMode,
  fits?: (title: string) => boolean) {
  // The old template enabled line wrapping for the whole table only when at least one title crossed the threshold.
  const effectiveMode = mode === 2 && !rows.some(row => !withinLegacyBudget(row.title.trim())) ? 0 : mode;
  let height = 0;
  const layout = rows.map(row => {
    const lines = trialDamageTitleLines(row.title, effectiveMode, fits);
    const top = height;
    const rowHeightWithTitle = rowHeight + (lines.length - 1) * trialDamageTitleLineHeight;
    height += rowHeightWithTitle;
    return { lines, top, height: rowHeightWithTitle };
  });
  return { rows: layout, height };
}
