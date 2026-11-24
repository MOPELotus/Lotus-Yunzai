import { verifyBuiltinResources } from "../lib/builtin-resource-validation.ts";
import { runInitializationStage } from "../lib/initialization-progress.ts";
import { installTerminalLogging } from "../lib/terminal-log-format.ts";
installTerminalLogging();
try {
  const result = await runInitializationStage("核对内置程序资源", progress =>
    verifyBuiltinResources(new URL("../", import.meta.url), undefined, progress));
  console.info(`[资源] 已核对 ${result.checked} 个内置文件（${(result.bytes / 1024 ** 2).toFixed(1)} MiB）。`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "内置资源核对失败。");
  process.exitCode = 1;
}
