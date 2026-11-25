import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockFile } from "../lib/file-lock.ts";
import { exists, move, writeJournal } from "../lib/filesystem-transaction.ts";
import { publishMigrationPayload } from "../lib/migration-publication.ts";
import { migrationArguments, type MigrationInputs } from "../lib/migration-trss-wish.ts";
import { stageMigration } from "./migrate-stage.ts";
import { migrationScheduleVersion } from "../lib/migration-default-schedule.ts";

type Staged = Awaited<ReturnType<typeof stageMigration>>;
interface PreparedMigration {
  readonly version: 1;
  readonly source: string;
  readonly target: string;
  readonly plugins: readonly string[];
  readonly report: {
    readonly archiveCount: number;
    readonly profiles: Staged["profiles"];
    readonly officialBindings?: Staged["officialBindings"];
    readonly schedules: Staged["schedules"];
    readonly schedulePolicy: Staged["schedulePolicy"];
    readonly gameData: Staged["gameData"];
    readonly sharedGameHistory: Staged["sharedGameHistory"];
    readonly coreConfig: Staged["coreConfig"];
    readonly groupConfig: Staged["groupConfig"];
    readonly panelRank?: Staged["panelRank"];
    readonly gachaDisplay?: Staged["gachaDisplay"];
    readonly genshinWish?: Staged["genshinWish"];
    readonly trssWish?: Staged["trssWish"];
    readonly starRailWarp?: Staged["starRailWarp"];
    readonly starRailIndependentWarp?: Staged["starRailIndependentWarp"];
    readonly starRailPersonalPools?: Staged["starRailPersonalPools"];
    readonly zzzRecall?: Staged["zzzRecall"];
    readonly zzzChallengeReminder?: Staged["zzzChallengeReminder"];
    readonly updateNotice?: Staged["updateNotice"];
    readonly keywords: Staged["keywords"];
    readonly lolomi?: Staged["lolomi"];
    readonly networkConfig: Staged["networkConfig"];
    readonly globalConfig: Staged["globalConfig"];
    readonly mediaState: Staged["mediaState"];
    readonly memeState?: Staged["memeState"];
    readonly atlas: Staged["atlas"];
    readonly starRailTheme: Staged["starRailTheme"];
    readonly starRailReincarnationTheme?: Staged["starRailReincarnationTheme"];
    readonly shopAudit: Staged["shopAudit"];
    readonly redeem: Staged["redeem"];
    readonly dailyNoteReminders?: Staged["dailyNoteReminders"];
    readonly state: Staged["state"]["plan"];
    readonly heldPlugins: Staged["retained"]["held"];
    readonly deferredPlugins: Staged["deferredPlugins"];
  };
}

async function loadPrepared(directory: string, source: string, target: string): Promise<PreparedMigration> {
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error($t("scripts.migrate.text_5799c14bc5"));
  const file = join(directory, "plan.json");
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 256 * 1024) throw new Error($t("scripts.migrate.text_2520464652"));
  const result = JSON.parse(await readFile(file, "utf8")) as PreparedMigration;
  if (!result || result.version !== 1 || !Array.isArray(result.plugins) ||
      !result.plugins.every(path => typeof path === "string") || !result.report || typeof result.report !== "object") {
    throw new Error($t("scripts.migrate.text_2520464652"));
  }
  if (result.report.schedulePolicy?.version !== migrationScheduleVersion) {
    throw new Error($t("scripts.migrate.old_schedule_policy"));
  }
  if (result.source !== source || result.target !== target) {
    throw new Error($t("scripts.migrate.text_4eaffaac91"));
  }
  return result;
}

async function prepare(source: string, target: string, directory: string, inputs: MigrationInputs, signal?: AbortSignal): Promise<PreparedMigration> {
  const staged = await stageMigration(source, target, signal, inputs);
  try {
    const payload = join(staged.directory, "payload");
    await rename(staged.state.directory, payload);
    const backup = join(payload, "backup");
    if (staged.backup.status !== "empty" || staged.retained.heldDirectory || staged.retained.status === "published") {
      await mkdir(backup, { mode: 0o700, recursive: true });
    }
    if (staged.backup.status !== "empty") await move(staged.backup.directory, join(backup, "plugins"));
    if (staged.retained.heldDirectory) await move(staged.retained.heldDirectory, join(backup, "held-plugins"));
    if (staged.retained.status === "published") await move(staged.retained.directory, join(payload, "plugins"));
    const prepared = {
      version: 1,
      source,
      target,
      plugins: staged.retained.retained.map(entry => entry.path),
      report: {
        archiveCount: staged.backup.archived,
        profiles: staged.profiles,
        officialBindings: staged.officialBindings,
        schedules: staged.schedules,
        schedulePolicy: staged.schedulePolicy,
        gameData: staged.gameData,
        sharedGameHistory: staged.sharedGameHistory,
        coreConfig: staged.coreConfig,
        groupConfig: staged.groupConfig,
        panelRank: staged.panelRank,
        gachaDisplay: staged.gachaDisplay,
        genshinWish: staged.genshinWish,
        trssWish: staged.trssWish,
        starRailWarp: staged.starRailWarp,
        starRailIndependentWarp: staged.starRailIndependentWarp,
        starRailPersonalPools: staged.starRailPersonalPools,
        zzzRecall: staged.zzzRecall,
        zzzChallengeReminder: staged.zzzChallengeReminder,
        updateNotice: staged.updateNotice,
        keywords: staged.keywords,
        lolomi: staged.lolomi,
        networkConfig: staged.networkConfig,
        globalConfig: staged.globalConfig,
        mediaState: staged.mediaState,
        memeState: staged.memeState,
        atlas: staged.atlas,
        starRailTheme: staged.starRailTheme,
        starRailReincarnationTheme: staged.starRailReincarnationTheme,
        shopAudit: staged.shopAudit,
        redeem: staged.redeem,
        dailyNoteReminders: staged.dailyNoteReminders,
        state: staged.state.plan,
        heldPlugins: staged.retained.held,
        deferredPlugins: staged.deferredPlugins,
      },
    } as const;
    await writeJournal(join(staged.directory, "plan.json"), prepared, true);
    signal?.throwIfAborted();
    await move(staged.directory, directory);
    return prepared;
  } finally {
    await rm(staged.directory, { recursive: true, force: true });
  }
}

export async function migrateInstallation(sourcePath: string, targetPath: string, signal?: AbortSignal, inputs: MigrationInputs = {}) {
  const [source, target] = await Promise.all([realpath(sourcePath), realpath(targetPath)]);
  const directory = join(dirname(target), "." + basename(target) + ".lotus-migration-prepared");
  const lock = await lockFile(directory + ".sqlite", $t("scripts.migrate.text_c4f9e29ea5"), 0);
  try {
    signal?.throwIfAborted();
    const prepared = await exists(directory)
      ? await loadPrepared(directory, source, target)
      : await prepare(source, target, directory, inputs, signal);
    if (inputs.trssWishSnapshot && !prepared.report.trssWish) {
      throw new Error($t("scripts.migrate.text_ae1b21dded"));
    }
    signal?.throwIfAborted();
    const result = await publishMigrationPayload(target, join(directory, "payload"), async () => {
      signal?.throwIfAborted();
    }, prepared.plugins);
    return { ...result, ...prepared.report };
  } finally {
    lock.close();
  }
}

if (import.meta.main) {
  const selected = migrationArguments(Bun.argv.slice(2), Bun.env.LOTUS_GENSHIN_TRSS_WISH_SNAPSHOT_URL);
  if (!selected) {
    console.error($t("scripts.migrate.text_53e0d37568"));
    process.exitCode = 2;
  } else {
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error($t("scripts.migrate.text_c6d906eede")));
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    try {
      const outcome = await migrateInstallation(selected.source, fileURLToPath(new URL("../", import.meta.url)), controller.signal, selected.inputs);
      console.log(JSON.stringify(outcome, null, 2));
    } catch (error) {
      if (error instanceof Error && !("code" in error)) console.error(error.message);
      else console.error($t("scripts.migrate.text_2fa1ad7929"));
      process.exitCode = 1;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}
