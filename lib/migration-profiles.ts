import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { importProfiles } from "../packages/account/index.ts";
import { legacyLotusDirectories } from "./lotus-global-config.ts";

const sourcePaths = [
  ["data", "users"],
  ...legacyLotusDirectories.map(name => ["plugins", name, "data", "users"]),
];

export async function stageLegacyProfiles(source: string, stateDirectory: string, signal?: AbortSignal) {
  const target = join(stateDirectory, "data", "users");
  const result = { sources: 0, imported: 0, unchanged: 0 };
  for (const parts of sourcePaths) {
    signal?.throwIfAborted();
    const directory = join(source, ...parts);
    try {
      if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
        throw new Error($t("lib.migration-profiles.text_e3a411e257"));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const migrated = await importProfiles(directory, target, true);
    if (migrated.conflict || migrated.invalid) {
      throw new Error($t("lib.migration-profiles.text_1482d351f8", { "conflict": migrated.conflict, "invalid": migrated.invalid }));
    }
    result.sources++;
    result.imported += migrated.imported;
    result.unchanged += migrated.unchanged;
  }
  signal?.throwIfAborted();
  return result;
}
