import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";

const sourceReason = rejectionReason(["lolomi-calc"], []);
const canonicalPlugin = "plugins/lolomi-calc";
const booleanFields = ["lolomicalc", "lolomiartis", "templateteam", "conscompare"] as const;
const maxBytes = 256 * 1024;

function legacySettings(bytes: Uint8Array) {
  try {
    const raw: unknown = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const values = raw as Record<string, unknown>;
    const engine = values.engineMode ?? "auto";
    if (typeof engine !== "string" || !["auto", "lolomi", "miao"].includes(engine)) return;
    const result: Record<string, boolean | string> = { engineMode: engine };
    for (const key of booleanFields) {
      const value = values[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") return;
      result[key] = value;
    }
    // The old score chooser treats an omitted lolomiartis in an existing file as disabled.
    result.lolomiartis ??= false;
    return result;
  } catch { return; }
}

export async function stageLegacyLolomiConfig(archive: string | undefined, stage: string,
  plugins: readonly LegacyPluginPlanEntry[], signal?: AbortSignal) {
  if (!archive) return { active: false, deferred: false };
  const paths = plugins.flatMap(plugin => plugin.status === "archive" && plugin.kind === "directory" &&
    plugin.reason === sourceReason ? [plugin.path] : []);
  const path = paths.includes(canonicalPlugin) ? canonicalPlugin : paths.length === 1 ? paths[0] : undefined;
  if (!path) return { active: false, deferred: paths.length > 1 };
  const directory = join(archive, basename(path), "config");
  const local = await readMigrationSourceFile(archive, join(directory, "config.yaml"), maxBytes, signal);
  const input = local ?? await readMigrationSourceFile(archive, join(directory, "system", "config.yaml"), maxBytes, signal);
  if (!input) return { active: false, deferred: false };
  const settings = legacySettings(input.bytes);
  if (!settings) return { active: false, deferred: true };

  const output = join(stage, "config");
  await mkdir(output, { mode: 0o700, recursive: true });
  if (await realpath(output) !== output) throw new Error($t("lib.migration-lolomi-config.text_cbcaef444d"));
  signal?.throwIfAborted();
  await writeFile(join(output, "genshin-damage.yaml"), Bun.YAML.stringify(settings), { flag: "wx", mode: 0o600 });
  return { active: true, deferred: false };
}
