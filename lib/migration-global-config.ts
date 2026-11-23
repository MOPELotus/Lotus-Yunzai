import { projectGroupCleanupConfig } from "./group-cleanup-config.ts";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { legacyLotusDirectories, resolveLotusGlobalConfig } from "./lotus-global-config.ts";
import { MigrationSourceFileError, readMigrationSourceFile } from "./migration-files.ts";
import type { LegacyDailyNoteReminderSettings } from "./migration-daily-note-reminders.ts";
import { projectPanelTrialDisplay } from "./migration-panel-trial-display.ts";
import { projectLegacyMediaConfig } from "./migration-media-config.ts";
import { projectShowcaseSettings, type ShowcaseArchive } from "./migration-showcase.ts";
import { configuredSiteIcpNumber } from "./web-icp.ts";

type Config = Record<string, unknown>;

function projectSettings(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, (value as Config)[key]]));
}

const supported = {
  scheduler: ["enable", "run_due_cron", "plan_generate_cron", "catch_up_cron", "mode", "fixed_time", "random", "late_registration"],
  permissions: ["default_policy", "users", "groups", "scopes"],
  coin_shop: ["enable", "path", "public_url", "icp_number", "ticket_minutes", "session_hours", "panel_ticket_minutes", "panel_session_hours"],
  daily_note_reminders: ["enable", "cooldown_hours", "cron", "message"],
} as const;

async function readGlobal(root: string, prefix: string): Promise<Config | undefined> {
  for (const local of ["config/global.yaml", "config/config/global.yaml"]) {
    const path = join(root, prefix, local);
    const file = await readMigrationSourceFile(root, path, 256 * 1024).catch(error => {
      if (!(error instanceof MigrationSourceFileError)) throw error;
      throw new Error(error.reason === "changed" ? "旧全局配置在迁移期间发生变化。" : "旧全局配置须为副本中的普通 YAML 文件。");
    });
    if (!file) continue;
    try {
      const config: unknown = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
      if (config === null || config === undefined) return {};
      if (typeof config === "object" && !Array.isArray(config)) return config as Config;
    } catch {}
    throw new Error("旧全局配置须为有效的 YAML 映射。");
  }
}

/** Materialize settings whose running consumers previously reached into rejected plugin directories. */
export async function stageLegacyGlobalConfig(source: string, stage: string, signal?: AbortSignal,
  legacyDailyNote?: LegacyDailyNoteReminderSettings, showcaseArchive?: ShowcaseArchive) {
  signal?.throwIfAborted();
  const [local, ...legacy] = await Promise.all([readGlobal(source, ""),
    ...legacyLotusDirectories.map(id => readGlobal(source, `plugins/${id}`))]);
  const effective = await resolveLotusGlobalConfig(local ?? {}, async id => legacy[legacyLotusDirectories.indexOf(id)]);
  const media = projectLegacyMediaConfig(local ?? {}, legacy.filter((config): config is Config => config !== undefined));
  const showcase = await projectShowcaseSettings(local ?? {}, showcaseArchive, signal);
  const trial = await projectPanelTrialDisplay(local ?? {}, showcaseArchive, signal);
  const projected: Config = { ...media.config, ...showcase.config,
    ...(Object.keys(trial.config).length && { panel_trial: trial.config }) };
  for (const [key, fields] of Object.entries(supported)) {
    if (Object.hasOwn(effective, key)) projected[key] = projectSettings(effective[key], fields);
  }
  const shop = projected.coin_shop;
  if (shop && typeof shop === "object" && Object.hasOwn(shop, "icp_number")) {
    const settings = shop as Config;
    const icpNumber = configuredSiteIcpNumber(settings.icp_number);
    if (icpNumber === undefined) delete settings.icp_number;
    else settings.icp_number = icpNumber;
  }
  if (legacyDailyNote && !Object.hasOwn(effective, "daily_note_reminders")) {
    projected.daily_note_reminders = {
      enable: legacyDailyNote.enabled, cron: legacyDailyNote.cron,
      ...(legacyDailyNote.cooldownHours !== undefined && { cooldown_hours: legacyDailyNote.cooldownHours }),
      ...(legacyDailyNote.message !== undefined && { message: legacyDailyNote.message }),
    };
  }
  const cleanup = projectGroupCleanupConfig(effective.groups);
  if (Object.keys(cleanup).length) projected.groups = { cleanup };
  const sections = Object.keys(projected);
  signal?.throwIfAborted();
  if (sections.length) {
    const directory = join(stage, "config");
    await mkdir(directory, { mode: 0o700, recursive: true });
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) {
      throw new Error("全局配置暂存路径须为实体目录。");
    }
    await writeFile(join(directory, "global.yaml"), Bun.YAML.stringify(projected), { flag: "wx", mode: 0o600 });
  }
  return { sections, deferredMedia: media.deferred,
    ...(showcase.deferred.length && { deferredShowcase: showcase.deferred }),
    ...(trial.deferred.length && { deferredPanelTrial: trial.deferred }) };
}
