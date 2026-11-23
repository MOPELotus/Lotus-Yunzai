import { defaultGachaDisplaySettings, parseGachaDisplaySettings } from "@lotus-yunzai/gacha/display-settings";
import { readCanonicalLocalConfiguration } from "./lotus-global-config-write.ts";

export const gachaDisplayConfigName = "gacha-display";
export const gachaDisplayConfigBytes = 256 * 1024;

export function readGachaDisplayConfig(root: URL) {
  return readCanonicalLocalConfiguration(root, gachaDisplayConfigName, gachaDisplayConfigBytes);
}

export async function readGachaDisplaySettings(root: URL) {
  try {
    return parseGachaDisplaySettings(await readGachaDisplayConfig(root));
  } catch {
    return defaultGachaDisplaySettings;
  }
}
