import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { readMigrationSourceFile } from "../lib/migration-files.ts";
import { parseStarRailSummary, prepareStarRailSummaryHandback, StarRailSummaryHandbackError } from "../lib/starrail-summary-handback.ts";
import { containsPath, publishLegacyJsonExport } from "./legacy-gacha-output.ts";

const maximum = 32 * 1024 * 1024;
const [direction, ...args] = Bun.argv.slice(2);
const exporting = args[0] === "--export";
const [output, baseline, later, qq, uid, region] = exporting ? args.slice(1) : [undefined, ...args];
if ((direction !== "to-old" && direction !== "to-modern") || args.length !== (exporting ? 7 : 5) ||
    !baseline || !later || !qq || !uid || !/^[1-9]\d{0,18}$/u.test(qq) || !/^[1-9]\d{8,9}$/u.test(uid) ||
    (region !== "prod_gf_cn" && region !== "prod_qd_cn") || (exporting && !output) ||
    [output, baseline, later].some(value => value?.startsWith("--"))) {
  console.error("用法：bun --no-env-file scripts/prepare-legacy-star-rail-summary.ts <to-old|to-modern> [--export <独立导出目录>] <基准官方汇总根副本> <较新官方汇总根副本> <QQ> <UID> <国服区服>");
  process.exit(2);
}

try {
  const paths = await Promise.all([baseline, later, ...(output ? [output] : [])].map(async (input) => {
    const path = await realpath(input);
    if (!(await lstat(path)).isDirectory()) throw new StarRailSummaryHandbackError("官方汇总输入和导出须为目录。");
    return path;
  }));
  if (paths.some((path, i) => paths.some((other, j) => i !== j && containsPath(path, other)))) {
    throw new StarRailSummaryHandbackError("两份已停写的官方汇总副本及导出目录须分别独立。");
  }
  const inputs = paths.slice(0, 2);
  const read = (root: string) => readMigrationSourceFile(root, join(root, qq, `${uid}.json`), maximum);
  const [first, second] = await Promise.all(inputs.map(read));
  if (!first || !second) throw new StarRailSummaryHandbackError("官方汇总的两份指定档案都须存在。");
  const { counts, document } = prepareStarRailSummaryHandback(parseStarRailSummary(first.bytes), parseStarRailSummary(second.bytes),
    { qq, uid, region }, direction);
  const content = document === undefined ? second.bytes : Buffer.from(JSON.stringify(document, null, 2) + "\n");
  if (content.length > maximum) throw new StarRailSummaryHandbackError("星铁官方汇总超过交还文件大小上限。");
  const [checkedFirst, checkedSecond] = await Promise.all(inputs.map(read));
  if (!checkedFirst || !checkedSecond || ![first, second].every((entry, i) => {
    const checked = i === 0 ? checkedFirst : checkedSecond;
    return entry.dev === checked.dev && entry.ino === checked.ino && entry.bytes.equals(checked.bytes);
  })) throw new StarRailSummaryHandbackError("官方汇总输入在核对期间发生变化，请重新取得停写副本。");
  const result = paths[2] ? await publishLegacyJsonExport(paths[2], "starrail-summary", content) : { written: false };
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  console.log(JSON.stringify({ mode: exporting ? "export" : "dry-run", direction, counts,
    baselineSHA256: digest(first.bytes), laterSHA256: digest(second.bytes), outputSHA256: digest(content), ...result }));
} catch (error) {
  console.error(error instanceof StarRailSummaryHandbackError ? error.message : "无法读取两份星铁官方汇总或写入独立导出目录。");
  process.exitCode = 1;
}
