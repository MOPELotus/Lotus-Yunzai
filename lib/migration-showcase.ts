import { basename, join } from "node:path";
import { readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";
import { rejectionReason } from "./plugins/policy.ts";

const miaoReason = rejectionReason(["miao-plugin"], []);
const archiveLimit = 256 * 1024;
const ambiguous = Symbol("conflicting legacy showcase selectors");
const games = { genshin: "profileServer", starrail: "srProfileServer" } as const;
const regions = ["官服", "渠道服", "国际服"] as const;
type Game = keyof typeof games;
type LegacyKey = (typeof games)[Game];
type Region = typeof regions[number];
type Config = Readonly<Record<string, unknown>>;
type Deferred = { readonly game: Game; readonly region?: Region; readonly reason:
  "invalid-setting" | "private-provider" | "unsupported-region" | "ambiguous-plugin" };

export interface ShowcaseArchive {
  readonly directory: string;
  readonly plugins: readonly LegacyPluginPlanEntry[];
}

function configRecord(value: unknown): Config | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Config;
}

// Miao writes these two values as single-line literal exports. The syntax scan
// recognizes real exports without executing code, and the text read accepts only literals.
function readLegacySelectors(bytes: Uint8Array, keys: readonly LegacyKey[]) {
  const values = new Map<LegacyKey, string | null>();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const { exports } = new Bun.Transpiler({ loader: "js" }).scan(text);
    const source = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/gu,
      token => token.startsWith("/") ? token.replace(/[^\r\n]/gu, " ") :
        /[\r\n]/u.test(token) ? token.replace(/[^\r\n]/gu, "?") : token);
    for (const key of keys) {
      if (!exports.includes(key)) continue;
      const rows = [...source.matchAll(new RegExp(`^[ \\t]*export[ \\t]+const[ \\t]+${key}\\b([^\\r\\n]*)$`, "gmu"))];
      const literal = rows.length === 1 && /^\s*=\s*(?:(["'])([0-4]{1,3})\1|([0-4]{1,3}))\s*;?\s*$/u.exec(rows[0]![1]!);
      values.set(key, literal ? literal[2] ?? literal[3]! : null);
    }
  } catch {
    for (const key of keys) values.set(key, null);
  }
  return values;
}

async function archivedSelectors(archive: ShowcaseArchive, keys: readonly LegacyKey[], signal?: AbortSignal) {
  const candidates = archive.plugins.flatMap(plugin => plugin.status === "archive" && plugin.kind === "directory" &&
    plugin.reason === miaoReason ? [plugin.path] : []);
  const canonical = "plugins/miao-plugin";
  if (candidates.includes(canonical)) {
    // The old host's normal Miao consumer loads this exact directory.
    const candidate = await readMigrationSourceFile(archive.directory,
      join(archive.directory, basename(canonical), "config/cfg.js"), archiveLimit, signal);
    return candidate ? readLegacySelectors(candidate.bytes, keys) : undefined;
  }
  const inputs = await Promise.all(candidates.map(candidate => readMigrationSourceFile(archive.directory,
    join(archive.directory, basename(candidate), "config/cfg.js"), archiveLimit, signal)));
  const selectors = inputs.flatMap(input => {
    if (!input) return [];
    const values = readLegacySelectors(input.bytes, keys);
    return values.size ? [values] : [];
  });
  const effective = new Map<LegacyKey, string | null | typeof ambiguous>();
  for (const values of selectors) for (const [key, value] of values) {
    effective.set(key, effective.has(key) && effective.get(key) !== value ? ambiguous : value);
  }
  return effective;
}

/** Project only recognized public providers. Reports contain no original JS or credentials. */
export async function projectShowcaseSettings(current: Config, archive?: ShowcaseArchive, signal?: AbortSignal) {
  const config: Partial<Record<Game, { readonly showcase_server: string }>> = {};
  const deferred: Deferred[] = [];
  const entries = Object.entries(games) as [Game, LegacyKey][];
  const currentHas = (game: Game) => Object.hasOwn(configRecord(current[game]) ?? {}, "showcase_server");
  const keys = entries.flatMap(([game, key]) => currentHas(game) ? [] : [key]);
  const legacy = archive && keys.length ? await archivedSelectors(archive, keys, signal) : undefined;

  for (const [game, field] of entries) {
    const local = currentHas(game);
    const input = local ? configRecord(current[game])?.showcase_server : legacy?.get(field);
    if (input === ambiguous) {
      deferred.push({ game, reason: "ambiguous-plugin" });
      continue;
    }
    if (input === undefined) continue;
    const value = typeof input === "string" || typeof input === "number" ? String(input).trim() : "";
    if (!/^[0-4]{1,3}$/u.test(value)) {
      deferred.push({ game, reason: "invalid-setting" });
      continue;
    }

    const selected = regions.map((region, index) => {
      const code = value[index] ?? value[0]!;
      if (code === "1") {
        deferred.push({ game, region, reason: "private-provider" });
        return undefined;
      }
      if (game === "genshin" && index === 2 && code === "3") {
        deferred.push({ game, region, reason: "unsupported-region" });
        return undefined;
      }
      return code;
    });
    if (selected.every(code => code !== undefined)) config[game] = { showcase_server: value };
    else if (selected.some(code => code !== undefined)) {
      // Use the current public automatic provider only where the legacy choice cannot run.
      config[game] = { showcase_server: selected.map(code => code ?? "0").join("") };
    }
  }
  return { config, deferred };
}
