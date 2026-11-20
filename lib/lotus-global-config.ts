import { readOptionalLocalConfig } from "./config.ts";

export const legacyLotusDirectories = ["Lotus-Plugin", "Lotus-ReFactor"] as const;
const inheritedSections = ["atlas", "scheduler", "coin_shop", "permissions"] as const;

function section(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

export async function inheritLotusGlobalConfig(root: URL, current: Readonly<Record<string, unknown>>) {
  const inherited: Record<string, unknown> = {};
  const localScheduler = section(current.scheduler);
  for (const id of legacyLotusDirectories) {
    const pending = inheritedSections.filter(key => !Object.hasOwn(inherited, key) &&
      (!Object.hasOwn(current, key) || (key === "scheduler" && localScheduler)));
    if (!pending.length) break;
    const legacy = await readOptionalLocalConfig(new URL(`plugins/${id}/`, root), "global");
    if (!legacy) continue;
    for (const key of pending) {
      if (Object.hasOwn(legacy, key)) inherited[key] = legacy[key];
    }
  }
  const merged = { ...inherited, ...current };
  const legacyScheduler = section(inherited.scheduler);
  if (legacyScheduler && localScheduler) merged.scheduler = { ...legacyScheduler, ...localScheduler };
  return merged;
}

export async function readLotusGlobalConfig(root: URL) {
  return inheritLotusGlobalConfig(root, await readOptionalLocalConfig(root, "global") ?? {});
}
