import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { verifyBuiltinResources } from "../lib/builtin-resource-validation.ts";
import { runInitializationStage } from "../lib/initialization-progress.ts";
import { installTerminalLogging } from "../lib/terminal-log-format.ts";
installTerminalLogging();
try {
  const result = await runInitializationStage($t("scripts.verify-builtin-resources.text_e052933f97"), progress =>
    verifyBuiltinResources(new URL("../", import.meta.url), undefined, progress));
  console.info($t("scripts.verify-builtin-resources.text_edd149b0a3", { "checked": result.checked, "value2": (result.bytes / 1024 ** 2).toFixed(1) }));
} catch (error) {
  console.error(error instanceof Error ? error.message : $t("scripts.verify-builtin-resources.text_c6262b4e8e"));
  process.exitCode = 1;
}
