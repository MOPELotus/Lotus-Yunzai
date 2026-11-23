import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { parseWishSettings, type WishSettings } from "./genshin-wish-settings-model.ts";
import { GlobalConfigWriteError, readCanonicalLocalConfiguration, updateLocalConfiguration } from "./lotus-global-config-write.ts";

export const wishConfigName = "genshin-wish";
export const wishConfigMaxBytes = 512 * 1024;

export async function readGenshinWishSettings(root: URL): Promise<WishSettings> {
  const local = await readCanonicalLocalConfiguration(root, wishConfigName, wishConfigMaxBytes);
  if (["pink", "blue", "recallSeconds", "privateSingleRecallSeconds", "groups"].every(key => Object.hasOwn(local, key))) return parseWishSettings(local);
  const { readLegacyWishSettings } = await import("../plugins/genshin/wish-sim/settings.ts");
  return parseWishSettings(local, await readLegacyWishSettings());
}

export function updateGenshinWishSettings(root: URL, prepare: (previous: WishSettings) => WishSettings,
  active: () => boolean, signal?: AbortSignal) {
  return updateLocalConfiguration(root, wishConfigName, {
    signal, canWrite: active, canCommit: active,
    async resolveEffective() { return { ...await readGenshinWishSettings(root) }; },
    prepare(text, local, effective) {
      const previous = parseWishSettings(effective);
      const value = prepare(previous);
      if (isDeepStrictEqual(previous, value)) return { value };
      const document = parseDocument(text, { strict: true, uniqueKeys: true });
      if (document.errors.length) throw new GlobalConfigWriteError("config");
      for (const [key, next] of Object.entries(value)) {
        if (!isDeepStrictEqual(local[key], next)) document.set(key, next);
      }
      const yaml = document.toString({ lineWidth: 0 });
      if (Buffer.byteLength(yaml) > wishConfigMaxBytes || !isDeepStrictEqual(parseWishSettings(Bun.YAML.parse(yaml)), value)) {
        throw new GlobalConfigWriteError("config");
      }
      return { yaml, value };
    },
  });
}
