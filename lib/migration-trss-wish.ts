import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { lockFile } from "./file-lock.ts";
import { readGenshinWishSettings } from "./genshin-wish-settings.ts";
import { planGenshinWishSettings } from "./migration-genshin-wish.ts";
import type { LegacyMigrationPlan } from "./plugins/migration-plan.ts";

export interface MigrationInputs {
  readonly trssWishSnapshot?: { readonly sourceUrl?: string; readonly authorizationFile: string };
}

export function migrationArguments(args: readonly string[], snapshotUrl?: string) {
  const [source, option, authorizationFile, ...extra] = args;
  if (!source || source.startsWith("-")) return;
  if (option === undefined) return { source, inputs: {} };
  if (option !== "--trss-wish-authorization" || !authorizationFile || authorizationFile.startsWith("-") || extra.length) return;
  return { source, inputs: { trssWishSnapshot: { sourceUrl: snapshotUrl?.trim(), authorizationFile } } };
}

export async function migrateTrssWishSnapshot(plan: LegacyMigrationPlan, inputs: MigrationInputs, stage?: string,
  signal?: AbortSignal) {
  const snapshot = inputs.trssWishSnapshot;
  if (!snapshot) return;
  if (!snapshot.sourceUrl) throw new Error("续接旧 TRSS 限抽需要设置 LOTUS_GENSHIN_TRSS_WISH_SNAPSHOT_URL。");
  const { importTrssWishLimits } = await import("../plugins/genshin/wish-sim/trss-daily-import.ts");
  // Preview only reads the destination. A real import writes to the private overlay, which is published with config and data.
  const target = stage ?? plan.target;
  const report = await importTrssWishLimits({
    sourceUrl: snapshot.sourceUrl, authorizationFile: snapshot.authorizationFile,
    destinationDirectory: join(target, "data/genshin/wish-sim"),
    apply: stage !== undefined,
    readSettings: stage !== undefined ? () => readGenshinWishSettings(pathToFileURL(stage + "/"))
      : () => planGenshinWishSettings(plan.source, plan.plugins, signal),
    signal,
  }, lockFile);
  if (stage !== undefined && report.unavailable) {
    throw new Error(`有 ${report.unavailable} 个已授权的旧 TRSS 限抽会话无法读取，请核对隔离副本和读取权限后重试。`);
  }
  return report;
}
