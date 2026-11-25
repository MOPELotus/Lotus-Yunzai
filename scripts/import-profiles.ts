import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { importProfiles } from "../packages/account/index.ts";

const args = process.argv.slice(2);
const apply = args[0] === "--apply";
const [source, destination, ...extra] = apply ? args.slice(1) : args;
if (!source || !destination || extra.length || source.startsWith("--") || destination.startsWith("--")) {
  console.error($t("scripts.import-profiles.text_25564e0acb"));
  process.exit(2);
}

try {
  const report = await importProfiles(source, destination, apply);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...report }));
  if (report.conflict || report.invalid) process.exitCode = 1;
} catch {
  console.error($t("scripts.import-profiles.text_b6ecad044c"));
  process.exitCode = 1;
}
