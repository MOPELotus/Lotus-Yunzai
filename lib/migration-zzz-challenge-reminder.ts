import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { challengeReminderConfigFile, projectChallengeReminderConfig } from "../plugins/zzz/challenge-reminder-store.ts";
import { readMigrationSourceFile } from "./migration-files.ts";
import { zzzMigrationDirectories } from "./migration-zzz-recall.ts";
import type { LegacyPluginPlanEntry } from "./plugins/migration-plan.ts";

async function readSettings(root: string, file: string, signal?: AbortSignal) {
  const snapshot = await readMigrationSourceFile(root, file, 65_536, signal);
  if (!snapshot) return;
  const value: unknown = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes));
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value) ||
      ("enable" in value && typeof value.enable !== "boolean")) {
    throw new Error("绝区零挑战提醒配置须为 YAML 映射，enable 须为布尔值。");
  }
  return value;
}

export async function stageLegacyZzzChallengeReminder(source: string, archive: string | undefined, stage: string,
  plugins: readonly LegacyPluginPlanEntry[], signal?: AbortSignal) {
  const modern = await readSettings(source, join(source, challengeReminderConfigFile), signal);
  let legacy;
  if (archive) for (const directory of zzzMigrationDirectories(archive, plugins)) {
    const bundled = await readSettings(archive, join(directory, "defSet/remind.yaml"), signal);
    const local = await readSettings(archive, join(directory, "config/remind.yaml"), signal);
    if (bundled || local) {
      legacy = { ...bundled, ...local };
      break;
    }
  }
  const record = { ...projectChallengeReminderConfig(legacy, true), ...projectChallengeReminderConfig(modern) };
  const fields = Object.keys(record);
  if (!fields.length) return { fields };
  const directory = join(stage, "config");
  await mkdir(directory, { mode: 0o700, recursive: true });
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) {
    throw new Error("绝区零挑战提醒的暂存路径须为实体目录。");
  }
  signal?.throwIfAborted();
  await writeFile(join(stage, challengeReminderConfigFile), Bun.YAML.stringify(record), { flag: "wx", mode: 0o600 });
  return { fields };
}
