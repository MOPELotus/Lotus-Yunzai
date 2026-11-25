import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { fileURLToPath } from "node:url";
import { migrateTrssWishSnapshot, migrationArguments, type MigrationInputs } from "../lib/migration-trss-wish.ts";
import { planMigration, type LegacyMigrationPlan } from "../lib/plugins/migration-plan.ts";

export async function preflightMigration(source: string, target: string, inputs: MigrationInputs = {}, signal?: AbortSignal):
  Promise<LegacyMigrationPlan & { readonly trssWish?: Awaited<ReturnType<typeof migrateTrssWishSnapshot>> }> {
  signal?.throwIfAborted();
  const plan = await planMigration(source, target);
  signal?.throwIfAborted();
  const trssWish = await migrateTrssWishSnapshot(plan, inputs, undefined, signal);
  return trssWish ? { ...plan, trssWish } : plan;
}

if (import.meta.main) {
  const selected = migrationArguments(Bun.argv.slice(2), Bun.env.LOTUS_GENSHIN_TRSS_WISH_SNAPSHOT_URL);
  if (!selected) {
    console.error($t("scripts.migrate-plan.text_d455546f2b"));
    process.exitCode = 2;
  } else {
    try {
      const plan = await preflightMigration(selected.source, fileURLToPath(new URL("../", import.meta.url)), selected.inputs);
      console.log(JSON.stringify(plan, null, 2));
    } catch (error) {
      if (error instanceof Error && !("code" in error)) console.error(error.message);
      else console.error($t("scripts.migrate-plan.text_1fe31f97a4"));
      process.exitCode = 1;
    }
  }
}
