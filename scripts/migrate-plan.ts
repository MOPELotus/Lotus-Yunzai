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
    console.error("用法：bun run migrate:plan <旧安装副本路径> [--trss-wish-authorization 授权JSON]");
    process.exitCode = 2;
  } else {
    try {
      const plan = await preflightMigration(selected.source, fileURLToPath(new URL("../", import.meta.url)), selected.inputs);
      console.log(JSON.stringify(plan, null, 2));
    } catch (error) {
      if (error instanceof Error && !("code" in error)) console.error(error.message);
      else console.error("迁移预检无法读取旧安装副本或目标安装。");
      process.exitCode = 1;
    }
  }
}
