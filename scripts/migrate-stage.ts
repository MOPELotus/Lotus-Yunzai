import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageLegacyAtlasState } from "../lib/migration-atlas-state.ts";
import { stageLegacyCheckinSchedules } from "../lib/migration-checkin-schedules.ts";
import { stageLegacyCoreConfig } from "../lib/migration-core-config.ts";
import { stageLegacyGameData } from "../lib/migration-game-data.ts";
import { stageLegacyGlobalConfig } from "../lib/migration-global-config.ts";
import { stageLegacyGroupConfig } from "../lib/migration-group-config.ts";
import { stageLegacyProfiles } from "../lib/migration-profiles.ts";
import { stageLegacySharedGameHistory } from "../lib/migration-shared-game-history.ts";
import { stageLegacyShopAudit } from "../lib/migration-shop-audit.ts";
import { stageLegacyState } from "../lib/migration-state.ts";
import { stageLegacyPluginBackup } from "../lib/plugins/legacy-backup-stage.ts";
import { stageRetainedLegacyPlugins } from "../lib/plugins/legacy-retained-stage.ts";
import { planMigration } from "../lib/plugins/migration-plan.ts";

export async function stageMigration(source: string, target: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const plan = await planMigration(source, target);
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(dirname(plan.target), `.${basename(plan.target)}.lotus-migration-`));
  try {
    const archiveRoot = join(directory, "plugin-archive");
    await mkdir(archiveRoot, { mode: 0o700 });
    const backup = await stageLegacyPluginBackup(plan, archiveRoot, signal);
    const retained = await stageRetainedLegacyPlugins(plan, archiveRoot, signal);
    const state = await stageLegacyState(plan.source, directory, signal);
    const profiles = await stageLegacyProfiles(plan.source, state.directory, signal);
    const shopAudit = await stageLegacyShopAudit(plan.source, state.directory, signal);
    const schedules = await stageLegacyCheckinSchedules(plan.source, state.directory, signal);
    const gameData = await stageLegacyGameData(plan.source, state.directory, signal);
    const sharedGameHistory = await stageLegacySharedGameHistory(plan.source, state.directory, signal);
    const coreConfig = await stageLegacyCoreConfig(plan.source, state.directory, signal);
    const groupConfig = await stageLegacyGroupConfig(plan.source, state.directory, signal);
    const globalConfig = await stageLegacyGlobalConfig(plan.source, state.directory, signal);
    const atlas = await stageLegacyAtlasState(plan.source, state.directory, signal);
    signal?.throwIfAborted();
    const deferredPlugins = plan.plugins.filter(entry =>
      entry.status === "review" || entry.status === "scan-error" || entry.status === "protocol-candidate");
    return { version: 1, mode: "staged", directory, backup, retained, state, profiles, schedules, gameData,
      sharedGameHistory, coreConfig, groupConfig, globalConfig, atlas, shopAudit, deferredPlugins } as const;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [source, ...extra] = Bun.argv.slice(2);
  if (!source || source.startsWith("-") || extra.length) {
    console.error("用法：bun run migrate:stage <旧安装快照路径>");
    process.exitCode = 2;
  } else {
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error("迁移暂存已中止。"));
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    try {
      const result = await stageMigration(source, fileURLToPath(new URL("../", import.meta.url)), controller.signal);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      if (error instanceof Error && !("code" in error)) console.error(error.message);
      else console.error("迁移暂存无法读取或保存所需文件。");
      process.exitCode = 1;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}
