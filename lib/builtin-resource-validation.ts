import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { reportResourceProgress, type ResourceProgressCallback } from "./resource-progress.ts";

export async function verifyBuiltinResources(root: URL, signal?: AbortSignal, onProgress?: ResourceProgressCallback) {
  const directory = await realpath(fileURLToPath(root));
  const manifest = JSON.parse(await readFile(join(directory, "resources/builtin/manifest.json"), "utf8")) as {
    format: number; files: { path: string; bytes: number; sha256: string }[];
  };
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error($t("lib.builtin-resource-validation.text_26bf913720"));
  let checked = 0, bytes = 0;
  for (const entry of manifest.files) {
    signal?.throwIfAborted();
    if (typeof entry.path !== "string" || !/^(?:resources\/|packages\/[^/]+\/(?:assets|resources)\/|plugins\/[^/]+\/(?:assets|resources|[^/]*theme)\/|plugins\/[^/]+\/(?:[^/]+\/)*[^/]*-assets\/|vendor\/gt-manual\/public\/)/u.test(entry.path) ||
        entry.path.split("/").some(part => !part || part === "." || part === "..") || /[\\\0]/u.test(entry.path) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error($t("lib.builtin-resource-validation.text_9b05800c70"));
    const file = join(directory, entry.path);
    const stat = await lstat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.size !== entry.bytes || relative(directory, await realpath(dirname(file))).startsWith("..")) {
      throw new Error($t("lib.builtin-resource-validation.text_fd389597a5", { "path": entry.path }));
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
    if (hash.digest("hex") !== entry.sha256) throw new Error($t("lib.builtin-resource-validation.text_aba807d20e", { "path": entry.path }));
    bytes += stat.size;
    reportResourceProgress(onProgress, signal, "builtin-assets", $t("lib.builtin-resource-validation.text_5c0002a423", { "path": entry.path }), ++checked, manifest.files.length, $t("lib.builtin-resource-validation.text_3a116815bc"));
  }
  return { checked, bytes };
}
