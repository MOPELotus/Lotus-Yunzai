import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { fileURLToPath } from "node:url";

/** Repository-owned default artwork; runtime data and operator overrides stay separate. */
export function builtinResourceDirectory(path: string, root = new URL("../", import.meta.url)): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/u.test(path) || path.split("/").some(part => part === "." || part === "..")) {
    throw new Error($t("lib.builtin-resources.text_560e7179cd"));
  }
  return fileURLToPath(new URL(`resources/builtin/${path.replace(/\/$/u, "")}/`, root));
}
