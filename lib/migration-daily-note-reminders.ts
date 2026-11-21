import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createProfileStore, profileGames, type Game } from "@lotus-yunzai/account";
import { dailyNoteReminderBinding, dailyNoteReminderCooldown, writeMigratedDailyNoteReminders, type DailyNoteReminderEnrollment } from "./daily-note-reminders.ts";
import { readMigrationSourceFile } from "./migration-files.ts";
import { withinInstallation } from "./plugins/migration-plan.ts";

const configDirectory = "plugins/bujidao/config";
const maxSourceBytes = 1024 * 1024;
const hour = 60 * 60_000;
const defaultCooldown = 12 * hour;
const uidPattern = /^[1-9]\d{7,9}$/u;

function mapping(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

function positiveId(value: string) {
  const id = Number(value);
  return /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(id) ? id : undefined;
}

async function loadYaml(source: string, name: string, signal?: AbortSignal) {
  const file = await readMigrationSourceFile(source, join(source, configDirectory, name), maxSourceBytes, signal);
  if (!file) return;
  try {
    const input: unknown = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    if (input === undefined || input === null) return {};
    const result = mapping(input);
    if (result) return result;
  } catch {}
  throw new Error("旧体力推送配置须为有效 YAML 映射。");
}

export async function stageLegacyDailyNoteReminders(sourcePath: string, stagePath: string, signal?: AbortSignal, now = Date.now) {
  signal?.throwIfAborted();
  const [source, stage] = await Promise.all([realpath(sourcePath), realpath(stagePath)]);
  if (withinInstallation(source, stage) || withinInstallation(stage, source)) {
    throw new Error("旧安装副本与体力推送暂存目录必须分离。");
  }
  const [registrations, config] = await Promise.all([
    loadYaml(source, "defnote.yaml", signal), loadYaml(source, "config.yaml", signal),
  ]);
  const duration = dailyNoteReminderCooldown(config?.sendCD);
  const counts = { files: Number(!!registrations) + Number(!!config), enrolled: 0, invalid: 0, unverified: 0, ambiguous: 0,
    duplicates: 0, enabled: config?.NoteTask === true, cooldownHours: duration === undefined ? undefined : duration / hour };
  if (!registrations) return counts;
  const legacyUntil = Math.min(Number.MAX_SAFE_INTEGER, now() + (duration ?? defaultCooldown));
  const profiles = createProfileStore(join(stage, "data", "users"));
  const saved = new Map<string, Promise<Map<string, { profile: number; binding: string }[]>>>();

  function owners(qq: string, game: Game) {
    const key = `${qq}/${game}`;
    const prior = saved.get(key);
    if (prior) return prior;
    const found = (async () => {
      const rows = new Map<string, { profile: number; binding: string }[]>();
      for (const profile of await profiles.listIds(qq)) {
        signal?.throwIfAborted();
        for (const role of await profiles.requestContexts(qq, profile, [game]).catch(() => [])) {
          const binding = dailyNoteReminderBinding(role);
          if (!binding) continue;
          const matches = rows.get(role.role.uid) ?? [];
          matches.push({ profile, binding });
          rows.set(role.role.uid, matches);
        }
      }
      return rows;
    })();
    saved.set(key, found);
    return found;
  }

  const rows = new Map<string, DailyNoteReminderEnrollment>();
  for (const [botKey, users] of Object.entries(registrations)) {
    signal?.throwIfAborted();
    const bot = positiveId(botKey);
    const members = mapping(users);
    if (!bot || !members) { counts.invalid++; continue; }
    for (const [qqKey, groups] of Object.entries(members)) {
      const qq = positiveId(qqKey);
      const destinations = mapping(groups);
      if (!qq || bot === qq || !destinations) { counts.invalid++; continue; }
      for (const [groupKey, entry] of Object.entries(destinations)) {
        signal?.throwIfAborted();
        const group_id = positiveId(groupKey);
        const fields = mapping(entry);
        if (!group_id || !fields) { counts.invalid++; continue; }
        for (const game of profileGames) {
          const roles = fields[game];
          if (roles === undefined) continue;
          if (!Array.isArray(roles)) { counts.invalid++; continue; }
          if (!roles.length) continue;
          const setting = fields[`${game}_Resin`];
          const threshold = typeof setting === "string" && /^[1-9]\d{0,2}$/u.test(setting) ? Number(setting) : setting;
          if (typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold < 1 || threshold > 999) {
            counts.invalid += roles.length;
            continue;
          }
          for (const value of roles) {
            signal?.throwIfAborted();
            const uid = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
            if (typeof uid !== "string" || !uidPattern.test(uid)) { counts.invalid++; continue; }
            const key = `${bot}/${group_id}/${qq}/${game}/${uid}`;
            if (rows.has(key)) { counts.duplicates++; continue; }
            const matches = (await owners(qqKey, game)).get(uid);
            if (!matches?.length) { counts.unverified++; continue; }
            if (matches.length !== 1) { counts.ambiguous++; continue; }
            rows.set(key, { bot, group_id, qq, game, uid, ...matches[0]!, threshold, legacyUntil });
          }
        }
      }
    }
  }
  counts.enrolled = rows.size;
  if (!rows.size) return counts;
  const data = join(stage, "data");
  const destination = join(data, "daily-note", "reminders.sqlite");
  for (const folder of [data, dirname(destination)]) {
    await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (await realpath(folder) !== folder || !(await lstat(folder)).isDirectory()) {
      throw new Error("体力推送暂存须使用实体目录。");
    }
  }
  signal?.throwIfAborted();
  const file = await open(destination, "wx", 0o600);
  try {
    await file.close();
    writeMigratedDailyNoteReminders(destination, [...rows.values()]);
    signal?.throwIfAborted();
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
  return counts;
}
