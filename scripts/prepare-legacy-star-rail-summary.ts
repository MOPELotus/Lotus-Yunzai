import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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
  console.error($t("scripts.prepare-legacy-star-rail-summary.text_a265b541c5"));
  process.exit(2);
}

try {
  const paths = await Promise.all([baseline, later, ...(output ? [output] : [])].map(async (input) => {
    const path = await realpath(input);
    if (!(await lstat(path)).isDirectory()) throw new StarRailSummaryHandbackError($t("scripts.prepare-legacy-star-rail-summary.text_17b78b4a6e"));
    return path;
  }));
  if (paths.some((path, i) => paths.some((other, j) => i !== j && containsPath(path, other)))) {
    throw new StarRailSummaryHandbackError($t("scripts.prepare-legacy-star-rail-summary.text_49009e096a"));
  }
  const inputs = paths.slice(0, 2);
  const read = (root: string) => readMigrationSourceFile(root, join(root, qq, `${uid}.json`), maximum);
  const [first, second] = await Promise.all(inputs.map(read));
  if (!first || !second) throw new StarRailSummaryHandbackError($t("scripts.prepare-legacy-star-rail-summary.text_183ffc87dd"));
  const { counts, document } = prepareStarRailSummaryHandback(parseStarRailSummary(first.bytes), parseStarRailSummary(second.bytes),
    { qq, uid, region }, direction);
  const content = document === undefined ? second.bytes : Buffer.from(JSON.stringify(document, null, 2) + "\n");
  if (content.length > maximum) throw new StarRailSummaryHandbackError($t("scripts.prepare-legacy-star-rail-summary.text_98d050f1fe"));
  const [checkedFirst, checkedSecond] = await Promise.all(inputs.map(read));
  if (!checkedFirst || !checkedSecond || ![first, second].every((entry, i) => {
    const checked = i === 0 ? checkedFirst : checkedSecond;
    return entry.dev === checked.dev && entry.ino === checked.ino && entry.bytes.equals(checked.bytes);
  })) throw new StarRailSummaryHandbackError($t("scripts.prepare-legacy-star-rail-summary.text_f2b86aa563"));
  const result = paths[2] ? await publishLegacyJsonExport(paths[2], "starrail-summary", content) : { written: false };
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  console.log(JSON.stringify({ mode: exporting ? "export" : "dry-run", direction, counts,
    baselineSHA256: digest(first.bytes), laterSHA256: digest(second.bytes), outputSHA256: digest(content), ...result }));
} catch (error) {
  console.error(error instanceof StarRailSummaryHandbackError ? error.message : $t("scripts.prepare-legacy-star-rail-summary.text_70e9be3094"));
  process.exitCode = 1;
}
