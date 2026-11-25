import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { checkinHandbackVersions, prepareLegacyCheckinSchedule } from "../lib/checkin-schedule-handback.ts";
import { isCheckinScheduleDate } from "../lib/checkin-schedule-plan.ts";
import { createCheckinScheduleStore } from "../lib/checkin-schedule-store.ts";
import { containsPath, publishLegacyJsonExport } from "./legacy-gacha-output.ts";

async function directory(path: string) {
  const actual = await realpath(path);
  if (!(await stat(actual)).isDirectory()) throw new Error($t("scripts.prepare-legacy-checkin-schedule.text_2e835549db"));
  return actual;
}

const args = process.argv.slice(2);
const exporting = args[0] === "--export";
const [parent, current, oldRoot, version, date] = exporting ? args.slice(1) : [undefined, ...args];
const target = checkinHandbackVersions.find(value => value === version);
if (!current || !oldRoot || !target || !isCheckinScheduleDate(date) || args.length !== (exporting ? 6 : 4) ||
    (exporting && !parent) || [parent, current, oldRoot].some(value => value?.startsWith("--"))) {
  console.error($t("scripts.prepare-legacy-checkin-schedule.text_ecbfcbee0e"));
  process.exit(2);
}

try {
  const [currentPath, oldPath, outPath] = await Promise.all([directory(current), directory(oldRoot), parent ? directory(parent) : undefined]);
  const overlaps = (left: string, right: string) => containsPath(left, right) || containsPath(right, left);
  if (overlaps(currentPath, oldPath) || (outPath && (overlaps(outPath, currentPath) || overlaps(outPath, oldPath)))) {
    throw new Error($t("scripts.prepare-legacy-checkin-schedule.text_5203ae404b"));
  }
  const [source, legacy] = await Promise.all([
    createCheckinScheduleStore(currentPath).read(date), createCheckinScheduleStore(join(oldPath, "data", "schedules")).read(date),
  ]);
  if (!source) throw new Error($t("scripts.prepare-legacy-checkin-schedule.text_aad4fe13b7"));
  const { plan, counts } = await prepareLegacyCheckinSchedule(source, legacy, target);
  const result = outPath ? await publishLegacyJsonExport(outPath, "checkin-schedule", Buffer.from(JSON.stringify(plan, null, 2) + "\n")) : { written: false };
  const notice = counts.heldRetries ? $t("scripts.prepare-legacy-checkin-schedule.text_e06ca32662") : undefined;
  console.log(JSON.stringify({ mode: exporting ? "export" : "dry-run", date, targetVersion: target, ...counts, notice, ...result }));
} catch (error) {
  console.error(error instanceof Error && !("code" in error) ? error.message : $t("scripts.prepare-legacy-checkin-schedule.text_35eed154a5"));
  process.exitCode = 1;
}
