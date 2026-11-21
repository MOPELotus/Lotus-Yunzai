import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isCheckinScheduleDate } from "./checkin-schedule-plan.ts";
import { createCheckinScheduleStore } from "./checkin-schedule-store.ts";

const legacyDirectories = [
  { id: "old-installation", path: "data/schedules" },
  { id: "Lotus-ReFactor", path: "plugins/Lotus-ReFactor/data/schedules" },
  { id: "Lotus-Plugin", path: "plugins/Lotus-Plugin/data/schedules" },
] as const;

export async function stageLegacyCheckinSchedules(source: string, stage: string, signal?: AbortSignal) {
  const plans = new Map<string, { id: string; directory: string }[]>();
  let emptyFiles = 0;
  for (const { id, path } of legacyDirectories) {
    signal?.throwIfAborted();
    const directory = join(source, path);
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!info) continue;
    if (!info.isDirectory() || await realpath(directory) !== directory) throw new Error("旧签到计划路径须为实体目录。");
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".json")) continue;
      const date = file.slice(0, -5);
      if (!isCheckinScheduleDate(date)) continue;
      const stats = await lstat(join(directory, file));
      if (!stats.isFile() || stats.nlink !== 1) throw new Error("旧签到计划须为无硬链接的普通文件。");
      if (stats.size === 0) {
        emptyFiles++;
        continue;
      }
      const locations = plans.get(date) ?? [];
      locations.push({ id, directory });
      plans.set(date, locations);
    }
  }

  let entries = 0;
  if (plans.size) {
    const temporary = await mkdtemp(join(stage, ".lotus-schedules-"));
    try {
      for (const [date, locations] of plans) {
        signal?.throwIfAborted();
        const store = createCheckinScheduleStore(temporary, locations);
        entries += await store.update(date, plan => {
          if (!plan) throw new Error("旧签到计划在迁移期间消失。");
          return { plan, result: plan.entries.length };
        });
      }
      const destination = join(stage, "data", "schedules");
      await mkdir(dirname(destination), { mode: 0o700, recursive: true });
      await mkdir(destination, { mode: 0o700 });
      for (const date of plans.keys()) await rename(join(temporary, `${date}.json`), join(destination, `${date}.json`));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  return { days: plans.size, entries, emptyFiles };
}
