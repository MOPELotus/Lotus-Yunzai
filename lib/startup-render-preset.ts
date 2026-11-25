import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { isMap, isScalar, parseDocument } from "yaml";
import { readOptionalLocalConfig } from "./config.ts";
import { GlobalConfigWriteError, updateLocalConfiguration } from "./lotus-global-config-write.ts";
import { insertSourcePairs, replaceSourceScalar } from "./yaml-source-edits.ts";

export type ImageRenderPreset = "standard" | "low";
const field = "imageRenderPreset";

export async function needsInitialRenderPreset(root: URL): Promise<boolean> {
  return !Object.hasOwn(await readOptionalLocalConfig(root, "bot") ?? {}, field);
}

export async function persistInitialRenderPreset(root: URL, preset: ImageRenderPreset, signal: AbortSignal): Promise<void> {
  try {
    await updateLocalConfiguration(root, "bot", {
      signal, canWrite: () => true,
      prepare(text, local) {
        if (Object.hasOwn(local, field)) return { value: undefined };
        const doc = parseDocument(text, { keepSourceTokens: true });
        if (doc.errors.length) throw new GlobalConfigWriteError("config");
        const source = doc.contents;
        const line = `${field}: ${preset}`;
        const { start, end, value } = isScalar(source) && source.value === null
          ? replaceSourceScalar(text, source, line)
          : insertSourcePairs(text, isMap(source) ? source : undefined,
            [{ key: field, flow: preset, block: [line] }]);
        return { yaml: text.slice(0, start) + value + text.slice(end), value: undefined };
      },
    });
  } catch (cause) {
    signal.throwIfAborted();
    throw new Error($t("lib.startup-render-preset.text_1f6e4e92a5"), { cause });
  }
}
