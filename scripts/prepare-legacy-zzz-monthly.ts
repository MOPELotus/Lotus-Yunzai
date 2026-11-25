import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { realpath, stat } from "node:fs/promises";
import { prepareZzzMonthlyHandback } from "../plugins/zzz/monthly-handback.ts";
import { containsPath, publishLegacyJsonExport } from "./legacy-gacha-output.ts";

async function checkedDirectory(path: string) {
  const actual = await realpath(path);
  if (!(await stat(actual)).isDirectory()) throw new Error($t("scripts.prepare-legacy-zzz-monthly.text_722e08dbac"));
  return actual;
}

const args = process.argv.slice(2);
const exporting = args[0] === "--export";
const [parent, managed, legacy, qq, uid, region] = exporting ? args.slice(1) : [undefined, ...args];
if (!managed || !legacy || !qq || !uid || !region || args.length !== (exporting ? 7 : 5) ||
    [parent, managed, legacy, qq, uid, region].some(value => value?.startsWith("--")) ||
    !/^[1-9]\d{0,18}$/u.test(qq) || !/^[1-9]\d{7,9}$/u.test(uid) || (exporting && !parent)) {
  console.error($t("scripts.prepare-legacy-zzz-monthly.text_ed6dab92fd"));
  process.exit(2);
}

try {
  const [managedRoot, legacyRoot, output] = await Promise.all([
    checkedDirectory(managed), checkedDirectory(legacy), parent ? checkedDirectory(parent) : undefined,
  ]);
  if (containsPath(managedRoot, legacyRoot) || containsPath(legacyRoot, managedRoot) ||
      (output && (containsPath(managedRoot, output) || containsPath(legacyRoot, output) ||
        containsPath(output, managedRoot) || containsPath(output, legacyRoot)))) {
    throw new Error($t("scripts.prepare-legacy-zzz-monthly.text_01b576d83e"));
  }
  const { content, counts } = await prepareZzzMonthlyHandback({ managed: managedRoot, legacy: legacyRoot, qq, uid, region });
  const result = output ? await publishLegacyJsonExport(output, "zzz-monthly", content) : { written: false };
  console.log(JSON.stringify({ mode: exporting ? "export" : "dry-run", format: "ZZZ-Plugin 2057599", counts, ...result }));
} catch (error) {
  console.error(error instanceof SyntaxError ? $t("scripts.prepare-legacy-zzz-monthly.text_fb4040e11a") :
    error instanceof Error && (!("code" in error) || ["corrupt", "io", "invalid-input", "response"].includes(String(error.code))) ?
      error.message : $t("scripts.prepare-legacy-zzz-monthly.text_775462441e"));
  process.exitCode = 1;
}
