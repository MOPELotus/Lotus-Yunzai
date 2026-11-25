import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { lockFile } from "../lib/file-lock.ts";
import { importWorldBossRanking } from "../plugins/genshin/world-boss-ranking-import.ts";

const args = process.argv.slice(2);
const apply = args[0] === "--apply";
const [sourceFile, authorizationFile, profileDirectory, destinationDirectory, ...extra] = apply ? args.slice(1) : args;
if (!sourceFile || !authorizationFile || !profileDirectory || !destinationDirectory || extra.length ||
    [sourceFile, authorizationFile, profileDirectory, destinationDirectory].some((value) => value.startsWith("--"))) {
  console.error($t("scripts.import-world-boss-ranking.text_fffd70392f"));
  process.exit(2);
}

try {
  const report = await importWorldBossRanking({ sourceFile, authorizationFile, profileDirectory, destinationDirectory, apply }, lockFile);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...report }));
  if (report.conflict || report.unverified || report.missing) process.exitCode = 1;
} catch {
  console.error($t("scripts.import-world-boss-ranking.text_84466398a0"));
  process.exitCode = 1;
}
