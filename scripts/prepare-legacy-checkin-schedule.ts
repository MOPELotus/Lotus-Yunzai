import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { checkinHandbackVersions, prepareLegacyCheckinSchedule } from "../lib/checkin-schedule-handback.ts";
import { isCheckinScheduleDate } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { containsPath, publishLegacyJsonExport } from "./legacy-gacha-output.ts";

async function directory(path: string) {
  const actual = await realpath(path);
  if (!(await stat(actual)).isDirectory()) throw new Error("签到计划交还须使用目录副本。");
  return actual;
}

const args = process.argv.slice(2);
const exporting = args[0] === "--export";
const [parent, current, oldRoot, version, date] = exporting ? args.slice(1) : [undefined, ...args];
const target = checkinHandbackVersions.find(value => value === version);
if (!current || !oldRoot || !target || !isCheckinScheduleDate(date) || args.length !== (exporting ? 6 : 4) ||
    (exporting && !parent) || [parent, current, oldRoot].some(value => value?.startsWith("--"))) {
  console.error("用法：bun scripts/prepare-legacy-checkin-schedule.ts [--export <独立导出目录>] <新版计划根副本> <旧版安装根副本> <e28c6df|5aa3a70> <日期>");
  process.exit(2);
}

try {
  const [currentPath, oldPath, outPath] = await Promise.all([directory(current), directory(oldRoot), parent ? directory(parent) : undefined]);
  const overlaps = (left: string, right: string) => containsPath(left, right) || containsPath(right, left);
  if (overlaps(currentPath, oldPath) || (outPath && (overlaps(outPath, currentPath) || overlaps(outPath, oldPath)))) {
    throw new Error("新旧签到输入和导出目录须分别独立。");
  }
  const [source, legacy] = await Promise.all([
    createCheckinScheduleStore(currentPath).read(date), createCheckinScheduleStore(join(oldPath, "data", "schedules")).read(date),
  ]);
  if (!source) throw new Error("新版副本没有该日签到计划。");
  const { plan, counts } = await prepareLegacyCheckinSchedule(source, legacy, target);
  const result = outPath ? await publishLegacyJsonExport(outPath, "checkin-schedule", Buffer.from(JSON.stringify(plan, null, 2) + "\n")) : { written: false };
  const notice = counts.heldRetries ? "待补跑项目保留在新版原计划。旧端实际执行前须核验接收版本及账户守卫。" : undefined;
  console.log(JSON.stringify({ mode: exporting ? "export" : "dry-run", date, targetVersion: target, ...counts, notice, ...result }));
} catch (error) {
  console.error(error instanceof Error && !("code" in error) ? error.message : "无法读取签到计划副本或写入独立导出目录。");
  process.exitCode = 1;
}
