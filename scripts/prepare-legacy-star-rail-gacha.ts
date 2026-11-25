import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { realpath } from "node:fs/promises";
import { lockFile } from "../lib/file-lock.ts";
import { createStarRailGachaRecordArchive } from "../plugins/starrail/gacha-record-archive.ts";
import { containsPath, publishLegacyJsonExport } from "./legacy-gacha-output.ts";

const maxOutputBytes = 32 * 1024 * 1024;

const args = process.argv.slice(2);
const exporting = args[0] === "--export";
const [parent, managed, legacy, qq, uid, timezone] = exporting ? args.slice(1) : [undefined, ...args];
if (!managed || !legacy || !qq || !uid || !timezone || args.length !== (exporting ? 7 : 5) ||
    [parent, managed, legacy, qq, uid, timezone].some(value => value?.startsWith("--")) ||
    !/^[+-]?\d+(?:\.\d+)?$/u.test(timezone) || (exporting && !parent)) {
  console.error($t("scripts.prepare-legacy-star-rail-gacha.text_87949d3af2"));
  process.exit(2);
}

try {
  const [managedRoot, legacyRoot, output] = await Promise.all([realpath(managed), realpath(legacy), parent && realpath(parent)]);
  if (containsPath(managedRoot, legacyRoot) || containsPath(legacyRoot, managedRoot) ||
      (output && (containsPath(managedRoot, output) || containsPath(legacyRoot, output)))) {
    throw new Error($t("scripts.prepare-legacy-star-rail-gacha.text_5a18924e2f"));
  }
  const archive = createStarRailGachaRecordArchive({ directory: managedRoot, legacyDirectory: legacyRoot }, lockFile);
  const { document, format, counts } = await archive.prepareLegacyHandback({ qq, uid }, Number(timezone));
  const content = Buffer.from(JSON.stringify(document, null, 2) + "\n");
  if (content.length > maxOutputBytes) throw new Error($t("scripts.prepare-legacy-star-rail-gacha.text_2ae6bb67ac"));
  const result = output ? await publishLegacyJsonExport(output, "starrail", content) : { written: false };
  console.log(JSON.stringify({ mode: exporting ? "export" : "dry-run", format, counts, ...result }));
} catch (error) {
  console.error(error instanceof Error && (!("code" in error) || ["corrupt", "conflict"].includes(String(error.code)))
    ? error.message : $t("scripts.prepare-legacy-star-rail-gacha.text_abc8466219"));
  process.exitCode = 1;
}
