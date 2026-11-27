import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { fileURLToPath } from "node:url";
import { runInitializationStage } from "./initialization-progress.ts";

/** Explicit bootstrap only. Ordinary startup never invokes these download paths. */
export async function initializeRuntimeResources(root: URL, signal: AbortSignal, config: Readonly<Record<string, unknown>>) {
  const atlas = config.atlas as { sync_character_gallery?: boolean } | undefined;
  if (atlas?.sync_character_gallery !== false && await Bun.file(new URL("lib/character-gallery-sync.ts", root)).exists()) {
    const { syncCharacterGallery } = await import(new URL("lib/character-gallery-sync.ts", root).href) as typeof import("./character-gallery-sync.ts");
    await runInitializationStage($t("lib.initialize-resources.text_908b651319"), onProgress => syncCharacterGallery({
      root: fileURLToPath(new URL("data/character-gallery-synced/", root)), signal, onProgress,
      githubToken: Bun.env.GITHUB_TOKEN?.trim() || Bun.env.GH_TOKEN?.trim(),
    }), { signal });
  }
  if (await Bun.file(new URL("plugins/guides/initialize-resources.ts", root)).exists()) {
    const { prepareGuideResources } = await import(new URL("plugins/guides/initialize-resources.ts", root).href) as typeof import("../plugins/guides/initialize-resources.ts");
    await runInitializationStage($t("lib.initialize-resources.text_1906257d16"), onProgress => prepareGuideResources(root, signal, onProgress), { signal });
  }
  if (await Bun.file(new URL("plugins/media/services/tools/initialize.ts", root)).exists()) {
    const { prepareMediaEnvironment } = await import(new URL("plugins/media/services/tools/initialize.ts", root).href) as typeof import("../plugins/media/services/tools/initialize.ts");
    await runInitializationStage($t("lib.initialize-resources.text_b9c0fb6fd1"), onProgress => prepareMediaEnvironment(root, signal, onProgress), { signal });
  }
}
