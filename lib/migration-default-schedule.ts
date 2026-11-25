import { mkdir, lstat, realpath, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { readMigrationSourceFile, MigrationSourceFileError } from "./migration-files.ts";
import { defaultUpdateCron } from "./update-schedule-settings.ts";
import { characterGalleryCron } from "./character-gallery-schedule.ts";
import { partnerScheduleDefault } from "./panel-partner-schema.ts";

type Fields = Record<string, unknown>;
const object = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
export const migrationScheduleVersion = 1;
export const migrationDefaultClocks = {
  update: defaultUpdateCron,
  characterGallery: characterGalleryCron,
  atlas: "0 30 1,13 * * *",
  teamGuides: "0 0 2,14 * * *",
  otherGuides: "0 0 5,17 * * *",
  partner: partnerScheduleDefault,
} as const;

/** Final policy for a new installation, applied only to its unpublished private payload. */
export async function applyMigrationDefaultSchedule(stagePath: string, signal?: AbortSignal,
  { atlasInitialized = false }: { readonly atlasInitialized?: boolean } = {}) {
  const stage = resolve(stagePath);
  const info = await lstat(stage);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077 || await realpath(stage) !== stage) {
    throw new MigrationSourceFileError("unsafe");
  }
  let filesAdjusted = 0;
  async function directory(path: string) {
    const local = relative(stage, path);
    if (local.startsWith(".." + sep) || local === "..") throw new MigrationSourceFileError("unsafe");
    let current = stage;
    for (const part of local.split(sep).filter(Boolean)) {
      signal?.throwIfAborted(); current = join(current, part);
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const next = await lstat(current);
      if (!next.isDirectory() || await realpath(current) !== current) throw new MigrationSourceFileError("unsafe");
    }
  }
  async function replace(path: string, project: (source: Fields) => Fields, create: boolean) {
    const file = join(stage, path);
    const input = await readMigrationSourceFile(stage, file, 16 * 1024 * 1024, signal);
    if (!input && !create) return false;
    let decoded: unknown = {};
    if (input) decoded = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
    if (decoded !== null && (typeof decoded !== "object" || Array.isArray(decoded))) throw new MigrationSourceFileError("unsafe");
    const value = project(object(decoded));
    const bytes = Bun.YAML.stringify(value);
    if (input && JSON.stringify(decoded) === JSON.stringify(value)) return true;
    if (input) {
      const archive = join(stage, "backup/migration-schedule", path);
      await directory(dirname(archive));
      await writeFile(archive, input.bytes, { flag: "wx", mode: 0o600, signal });
    }
    await directory(dirname(file));
    const staged = file + ".schedule-" + crypto.randomUUID();
    try {
      await writeFile(staged, bytes, { flag: "wx", mode: 0o600, signal });
      signal?.throwIfAborted(); await rename(staged, file); filesAdjusted++;
    } finally { await rm(staged, { force: true }); }
    return true;
  }
  signal?.throwIfAborted();
  const bot = (source: Fields) => ({ ...source, update_time: 0, update_cron: defaultUpdateCron });
  const hasBot = await replace("config/bot.yaml", bot, false);
  await replace("config/config/bot.yaml", bot, !hasBot);
  const global = (source: Fields) => {
    const atlas = object(source.atlas);
    return {
      ...source,
      ...(Object.hasOwn(source, "atlas") || atlasInitialized ? { atlas: { ...atlas, auto_update: { ...object(atlas.auto_update),
        check_cron: migrationDefaultClocks.atlas, challenge_cron: migrationDefaultClocks.atlas } } } : {}),
      netease_partner: { ...object(source.netease_partner), schedule: partnerScheduleDefault },
    };
  };
  const hasGlobal = await replace("config/global.yaml", global, false);
  const hasLegacyGlobal = await replace("config/config/global.yaml", global, false);
  if (!hasGlobal && !hasLegacyGlobal) await replace("config/global.yaml", global, true);
  return { version: migrationScheduleVersion, timezone: "Asia/Shanghai", clocks: migrationDefaultClocks, filesAdjusted, checkinPolicy: "preserved" as const };
}
