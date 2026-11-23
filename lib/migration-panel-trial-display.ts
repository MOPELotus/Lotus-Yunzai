import { basename, join } from "node:path";
import { legacyArkTrialFields, readLegacyArkTrialSettings } from "./legacy-ark-trial-settings.ts";
import type { ShowcaseArchive } from "./migration-showcase.ts";
import { panelTrialConfigSection } from "./panel-trial-display.ts";
import { rejectionReason } from "./plugins/policy.ts";

const arkReason = rejectionReason(["ark-plugin"], []);
type LocalKey = typeof legacyArkTrialFields[number][1];
type LegacyKey = typeof legacyArkTrialFields[number][0];
type Deferred = { readonly field: LegacyKey; readonly reason: "invalid-setting" | "ambiguous-plugin" };

export async function projectPanelTrialDisplay(current: Readonly<Record<string, unknown>>, archive?: ShowcaseArchive, signal?: AbortSignal) {
  const config: Partial<Record<LocalKey, unknown>> = {};
  const deferred: Deferred[] = [];
  const section = panelTrialConfigSection(current.panel_trial);
  const pending = legacyArkTrialFields.filter(([, target]) => !Object.hasOwn(section ?? {}, target));
  const candidates = archive?.plugins.flatMap(plugin => plugin.status === "archive" && plugin.kind === "directory" &&
    plugin.reason === arkReason ? [plugin.path] : []) ?? [];
  const canonical = "plugins/ark-plugin";
  const directories = candidates.includes(canonical) ? [canonical] : candidates;
  const archived = archive && pending.length && (!Object.hasOwn(current, "panel_trial") || section)
    ? await Promise.all(directories.map(directory =>
      readLegacyArkTrialSettings(archive.directory, join(archive.directory, basename(directory), "config/cfg.js"), pending, signal))) : [];

  for (const [key, target] of legacyArkTrialFields) {
    if (section && Object.hasOwn(section, target)) {
      config[target] = section[target];
      continue;
    }
    const values = [...new Set(archived.flatMap(item => item.has(key) ? [item.get(key)!] : []))];
    if (!values.length) continue;
    const value = values[0]!;
    if (values.length > 1) deferred.push({ field: key, reason: "ambiguous-plugin" });
    else if (value === null) deferred.push({ field: key, reason: "invalid-setting" });
    else config[target] = value;
  }
  return { config, deferred };
}
