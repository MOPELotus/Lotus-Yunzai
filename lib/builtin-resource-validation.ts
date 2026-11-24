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
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("内置资源清单无效。");
  let checked = 0, bytes = 0;
  for (const entry of manifest.files) {
    signal?.throwIfAborted();
    if (typeof entry.path !== "string" || !/^(?:resources\/builtin|plugins\/[^/]+\/resources|packages\/skia\/assets)\//u.test(entry.path) ||
        entry.path.split("/").some(part => !part || part === "." || part === "..") || /[\\\0]/u.test(entry.path) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error("内置资源清单条目无效。");
    const file = join(directory, entry.path);
    const stat = await lstat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.size !== entry.bytes || relative(directory, await realpath(dirname(file))).startsWith("..")) {
      throw new Error(`内置资源缺失或大小不符：${entry.path}，请更新完整仓库及子模块。`);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
    if (hash.digest("hex") !== entry.sha256) throw new Error(`内置资源校验失败：${entry.path}，请恢复仓库原文件。`);
    bytes += stat.size;
    reportResourceProgress(onProgress, signal, "builtin-assets", `核对 ${entry.path}`, ++checked, manifest.files.length, "个");
  }
  return { checked, bytes };
}
