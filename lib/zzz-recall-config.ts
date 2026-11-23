import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const maxZzzRecallSeconds = 120;
export const defaultZzzRecallSeconds = 100;

export function parseZzzRecallSeconds(value: unknown) {
  const seconds = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.floor(seconds), maxZzzRecallSeconds);
}

async function readRecall(file: string) {
  try {
    const config: unknown = Bun.YAML.parse(await readFile(file, "utf8"));
    if (config && typeof config === "object" && Object.hasOwn(config, "recallMsg")) {
      return { value: (config as { recallMsg?: unknown }).recallMsg };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function readZzzRecallSeconds(file: string, legacyResources?: string) {
  const legacy = legacyResources && dirname(legacyResources);
  const configured = await readRecall(file) ?? (legacy
    ? await readRecall(join(legacy, "config/config.yaml")) ?? await readRecall(join(legacy, "defSet/config.yaml")) : undefined);
  return parseZzzRecallSeconds(configured?.value) ?? defaultZzzRecallSeconds;
}
