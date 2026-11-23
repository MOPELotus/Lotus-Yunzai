import { basename, join } from "node:path";
import type { AtlasRoleField, AtlasRoleSettings } from "../plugins/atlas/role-switches.ts";
import { readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";

export interface AtlasRoleArchive {
  readonly directory: string;
  readonly plugins: readonly LegacyPluginPlanEntry[];
}

const fields = { charWiki: "role_wiki", charWikiTalent: "role_talent", charPic: "role_photo", qFace: "role_q_face" } as const;
const miaoReason = rejectionReason(["miao-plugin"], []);
const canonical = "plugins/miao-plugin";

function literals(bytes: Uint8Array) {
  const settings = new Map<AtlasRoleField, boolean | undefined>();
  let text: string;
  let exported: string[];
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    exported = new Bun.Transpiler({ loader: "js" }).scan(text).exports;
  } catch {
    return settings;
  }
  // The old settings writer emits simple exports. Never execute the archived configuration.
  const source = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/gu,
    token => token.replace(/[^\r\n]/gu, token.startsWith("/") ? " " : "?"));
  for (const [legacy, field] of Object.entries(fields)) {
    if (!exported.includes(legacy)) continue;
    const rows = [...source.matchAll(new RegExp(`^[ \\t]*export[ \\t]+const[ \\t]+${legacy}\\b([^\\r\\n]*)$`, "gmu"))];
    const literal = rows.length === 1 ? /^\s*=\s*(true|false)\s*;?\s*$/u.exec(rows[0]?.[1] ?? "")?.[1] : undefined;
    settings.set(field, literal === undefined ? undefined : literal === "true");
  }
  return settings;
}

export async function projectAtlasRoleSettings(archive: AtlasRoleArchive | undefined, signal?: AbortSignal): Promise<Partial<AtlasRoleSettings>> {
  if (!archive) return {};
  const candidates = archive.plugins.flatMap(plugin => plugin.status === "archive" && plugin.kind === "directory" &&
    plugin.reason === miaoReason ? [plugin.path] : []);
  const inputs = await Promise.all((candidates.includes(canonical) ? [canonical] : candidates).map(async path => {
    const file = await readMigrationSourceFile(archive.directory, join(archive.directory, basename(path), "config/cfg.js"), 256 * 1024, signal);
    return file ? literals(file.bytes) : new Map<AtlasRoleField, boolean | undefined>();
  }));
  const result: Partial<AtlasRoleSettings> = {};
  for (const field of Object.values(fields)) {
    const values = inputs.filter(input => input.has(field)).map(input => input.get(field));
    const first = values[0];
    if (first !== undefined && values.every(value => first === value)) result[field] = first;
  }
  return result;
}
