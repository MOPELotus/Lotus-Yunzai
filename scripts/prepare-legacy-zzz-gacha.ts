import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { realpath, stat } from "node:fs/promises";
import { lockFile } from "../lib/file-lock.ts";
import { prepareZzzGachaHandback } from "../plugins/zzz/gacha-handback.ts";
import { containsPath, publishLegacyJsonExport } from "./legacy-gacha-output.ts";

const maxOutputBytes = 32 * 1024 * 1024;

async function checkedDirectory(path: string) {
  const actual = await realpath(path);
  if (!(await stat(actual)).isDirectory()) throw new Error($t("scripts.prepare-legacy-zzz-gacha.text_c245a279a7"));
  return actual;
}

const args = process.argv.slice(2);
const exporting = args[0] === "--export";
const [parent, managed, legacy, qq, uid, region] = exporting ? args.slice(1) : [undefined, ...args];
if (!managed || !legacy || !qq || !uid || !region || args.length !== (exporting ? 7 : 5) ||
    [parent, managed, legacy, qq, uid, region].some(value => value?.startsWith("--")) ||
    !/^[1-9]\d{0,18}$/u.test(qq) || !/^[1-9]\d{7,9}$/u.test(uid) || (exporting && !parent)) {
  console.error($t("scripts.prepare-legacy-zzz-gacha.text_e55bd8efd5"));
  process.exit(2);
}

try {
  const [managedRoot, legacyRoot, output] = await Promise.all([
    checkedDirectory(managed), checkedDirectory(legacy), parent ? checkedDirectory(parent) : undefined,
  ]);
  if (containsPath(managedRoot, legacyRoot) || containsPath(legacyRoot, managedRoot) ||
      (output && (containsPath(managedRoot, output) || containsPath(legacyRoot, output) ||
        containsPath(output, managedRoot) || containsPath(output, legacyRoot)))) {
    throw new Error($t("scripts.prepare-legacy-zzz-gacha.text_5a18924e2f"));
  }
  const { document, counts } = await prepareZzzGachaHandback({ managed: managedRoot, legacy: legacyRoot, qq, uid, region }, lockFile);
  const content = Buffer.from(JSON.stringify(document, null, 2) + "\n");
  if (content.length > maxOutputBytes) throw new Error($t("scripts.prepare-legacy-zzz-gacha.text_2ae6bb67ac"));
  const result = output ? await publishLegacyJsonExport(output, "zzz", content) : { written: false };
  console.log(JSON.stringify({ mode: exporting ? "export" : "dry-run", format: "ZZZ-Plugin 2057599", counts, ...result }));
} catch (error) {
  console.error(error instanceof Error && (!("code" in error) || ["corrupt", "io", "invalid-input"].includes(String(error.code)))
    ? error.message : $t("scripts.prepare-legacy-zzz-gacha.text_5075047abd"));
  process.exitCode = 1;
}
