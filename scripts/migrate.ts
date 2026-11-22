import { lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockFile } from "../lib/file-lock.ts";
import { exists, move, writeJournal } from "../lib/filesystem-transaction.ts";
import { publishMigrationPayload } from "../lib/migration-publication.ts";
import { verifyLegacyProtocolBackups } from "../lib/plugins/legacy-backup-stage.ts";
import { verifyStagedProtocolReceipts, type ProtocolMigrationOptions, type StagedProtocolReceipt } from "../lib/plugins/legacy-protocol-stage.ts";
import { stageMigration } from "./migrate-stage.ts";

type Staged = Awaited<ReturnType<typeof stageMigration>>;
interface PreparedMigration {
  readonly version: 1;
  readonly source: string;
  readonly target: string;
  readonly plugins: readonly string[];
  readonly protocolReceipts?: readonly StagedProtocolReceipt[];
  readonly report: {
    readonly archiveCount: number;
    readonly protocolReplacements?: readonly { readonly id: string; readonly legacyPath: string }[];
    readonly profiles: Staged["profiles"];
    readonly officialBindings?: Staged["officialBindings"];
    readonly schedules: Staged["schedules"];
    readonly gameData: Staged["gameData"];
    readonly sharedGameHistory: Staged["sharedGameHistory"];
    readonly coreConfig: Staged["coreConfig"];
    readonly groupConfig: Staged["groupConfig"];
    readonly keywords: Staged["keywords"];
    readonly networkConfig: Staged["networkConfig"];
    readonly globalConfig: Staged["globalConfig"];
    readonly mediaState: Staged["mediaState"];
    readonly atlas: Staged["atlas"];
    readonly starRailTheme: Staged["starRailTheme"];
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
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("迁移暂存须为私有实体目录。");
  const file = join(directory, "plan.json");
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 256 * 1024) throw new Error("迁移暂存清单无效。");
  const result = JSON.parse(await readFile(file, "utf8")) as PreparedMigration;
  if (!result || result.version !== 1 || !Array.isArray(result.plugins) ||
      !result.plugins.every(path => typeof path === "string") ||
      (result.protocolReceipts !== undefined && !Array.isArray(result.protocolReceipts)) || !result.report || typeof result.report !== "object") {
    throw new Error("迁移暂存清单无效。");
  }
  if (result.source !== source || result.target !== target) {
    throw new Error("当前目标已有使用另一来源的迁移记录。请核对要使用的安装目录。");
  }
  return result;
}

async function prepare(source: string, target: string, directory: string, signal?: AbortSignal,
  protocolOptions?: ProtocolMigrationOptions): Promise<PreparedMigration> {
  const staged = await stageMigration(source, target, signal, protocolOptions);
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
      ...(staged.protocolReceipts?.length && { protocolReceipts: staged.protocolReceipts }),
      report: {
        ...(staged.protocolReceipts?.length && {
          protocolReplacements: staged.protocolReceipts.map(({ id, legacyPath }) => ({ id, legacyPath })),
        }),
        archiveCount: staged.backup.archived,
        profiles: staged.profiles,
        officialBindings: staged.officialBindings,
        schedules: staged.schedules,
        gameData: staged.gameData,
        sharedGameHistory: staged.sharedGameHistory,
        coreConfig: staged.coreConfig,
        groupConfig: staged.groupConfig,
        keywords: staged.keywords,
        networkConfig: staged.networkConfig,
        globalConfig: staged.globalConfig,
        mediaState: staged.mediaState,
        atlas: staged.atlas,
        starRailTheme: staged.starRailTheme,
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

export async function migrateInstallation(sourcePath: string, targetPath: string, signal?: AbortSignal,
  protocolOptions?: ProtocolMigrationOptions) {
  const [source, target] = await Promise.all([realpath(sourcePath), realpath(targetPath)]);
  const directory = join(dirname(target), "." + basename(target) + ".lotus-migration-prepared");
  const lock = await lockFile(directory + ".sqlite", "旧安装迁移", 0);
  try {
    signal?.throwIfAborted();
    const prepared = await exists(directory)
      ? await loadPrepared(directory, source, target)
      : await prepare(source, target, directory, signal, protocolOptions);
    signal?.throwIfAborted();
    const verify = async (root: string) => {
      signal?.throwIfAborted();
      if (prepared.protocolReceipts?.length) {
        await verifyStagedProtocolReceipts(root, prepared.protocolReceipts, protocolOptions, signal);
        await verifyLegacyProtocolBackups(source, root, prepared.protocolReceipts, signal);
      }
      signal?.throwIfAborted();
    };
    const result = await publishMigrationPayload(target, join(directory, "payload"), verify, prepared.plugins,
      prepared.protocolReceipts?.length ? verify : undefined);
    return { ...result, ...prepared.report };
  } finally {
    lock.close();
  }
}

if (import.meta.main) {
  const [source, ...extra] = Bun.argv.slice(2);
  if (!source || source.startsWith("-") || extra.length) {
    console.error("用法：bun run migrate <旧安装快照路径>");
    process.exitCode = 2;
  } else {
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error("旧安装迁移已中止。"));
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    try {
      const outcome = await migrateInstallation(source, fileURLToPath(new URL("../", import.meta.url)), controller.signal);
      console.log(JSON.stringify(outcome, null, 2));
    } catch (error) {
      if (error instanceof Error && !("code" in error)) console.error(error.message);
      else console.error("旧安装迁移未能完成。");
      process.exitCode = 1;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}
