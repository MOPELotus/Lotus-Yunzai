import { reportResourceProgress, type ResourceProgressCallback } from "./resource-progress.ts";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationSourceFile } from "./migration-files.ts";

const transientDownloadErrors = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT"]);
type Asset = readonly [path: string, size: number, sha256: string];
type Download = (url: URL, init: RequestInit) => Promise<Response>;
type Status = "installed" | "available" | "configured" | "missing" | "incomplete";

interface FixedTheme {
  readonly resourcePath: string;
  readonly sourceRoots: readonly string[];
  readonly raw: string;
  readonly assets: readonly Asset[];
}

export interface FixedThemeOptions {
  readonly source?: URL;
  readonly override?: string;
  readonly download?: boolean | Download;
  readonly signal?: AbortSignal;
  readonly onProgress?: ResourceProgressCallback;
}

function missing(error: NodeJS.ErrnoException) {
  if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
}

function matches(bytes: Uint8Array, [, size, hash]: Asset) {
  return bytes.byteLength === size && createHash("sha256").update(bytes).digest("hex") === hash;
}

async function hasTheme(path: string, assets: readonly Asset[]) {
  return (await Promise.all(assets.map(async ([asset]) => {
    const file = await stat(join(path, asset)).catch(missing);
    return file?.isFile() && file.size > 0;
  }))).every(Boolean);
}

async function localTheme(path: string, assets: readonly Asset[]): Promise<"available" | "incomplete" | undefined> {
  if (await lstat(path).catch(missing)) return await hasTheme(path, assets) ? "available" : "incomplete";
}

async function readOriginal(asset: Asset, source: string, sourceRoots: readonly string[], signal?: AbortSignal) {
  const [path, size] = asset;
  for (const directory of sourceRoots) {
    const file = await readMigrationSourceFile(source, join(source, directory, path), size, signal).catch(() => undefined);
    signal?.throwIfAborted();
    if (file && matches(file.bytes, asset)) return file.bytes;
  }
}

async function readRemote(asset: Asset, raw: string, request: Download, signal: AbortSignal) {
  const [path, size] = asset;
  const url = new URL(path.split("/").map(encodeURIComponent).join("/"), raw);
  const response = await request(url, { redirect: "error", credentials: "omit", signal });
  if (response.status !== 200 || response.redirected || !response.body ||
      Number(response.headers.get("content-length")) > size) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  const bytes = Buffer.alloc(size);
  let offset = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    if (offset + chunk.byteLength > size) return;
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset === size && matches(bytes, asset)) return bytes;
}

function downloadOriginal(asset: Asset, raw: string, request: Download, signal: AbortSignal) {
  return readRemote(asset, raw, request, signal).catch((error: NodeJS.ErrnoException) => {
    if (!signal.aborted && transientDownloadErrors.has(error?.code ?? "")) {
      return readRemote(asset, raw, request, signal).catch(() => undefined);
    }
  });
}

/** Prepare static artwork once, during initialization or from an existing installation copy. */
export async function prepareFixedTheme(checkout: URL, { resourcePath, sourceRoots, raw, assets }: FixedTheme, {
  source = checkout, override, download, signal, onProgress,
}: FixedThemeOptions = {}): Promise<Status> {
  const report = (message: string, completed?: number, total?: number) => reportResourceProgress(onProgress, signal, "theme", message, completed, total);
  report("检查本地主题");
  signal?.throwIfAborted();
  if (override) return "configured";
  const root = await realpath(fileURLToPath(checkout));
  const target = join(root, resourcePath);
  // A complete local theme, including an administrator's linked directory, stays in use.
  const existing = await localTheme(target, assets);
  signal?.throwIfAborted();
  if (existing) return existing;
  const donor = await realpath(fileURLToPath(source));
  const deadline = AbortSignal.timeout(30_000);
  const downloadSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const request = typeof download === "function" ? download : fetch;
  const contents: { path: string; bytes: Uint8Array }[] = [];
  for (const [index, asset] of assets.entries()) {
    report(`准备 ${asset[0]}`, index, assets.length);
    const bytes = await readOriginal(asset, donor, sourceRoots, signal) ??
      (download ? await downloadOriginal(asset, raw, request, downloadSignal) : undefined);
    signal?.throwIfAborted();
    if (!bytes) return "missing";
    contents.push({ path: asset[0], bytes });
    report(`已取得 ${asset[0]}`, index + 1, assets.length);
  }

  for (const directory of [join(root, "data"), dirname(target)]) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) return "missing";
  }
  const stage = await mkdtemp(join(dirname(target), ".theme-"));
  try {
    for (const [index, { path, bytes }] of contents.entries()) {
      reportResourceProgress(onProgress, signal, "theme-write", `保存 ${path}`, index, contents.length);
      const file = join(stage, path);
      await mkdir(dirname(file), { mode: 0o700, recursive: true });
      await writeFile(file, bytes, { mode: 0o600, flag: "wx", signal });
    }
    signal?.throwIfAborted();
    const concurrent = await localTheme(target, assets);
    signal?.throwIfAborted();
    if (concurrent) return concurrent;
    try {
      await rename(stage, target);
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === "EEXIST" || code === "ENOTEMPTY") return await localTheme(target, assets) ?? "missing";
      throw error;
    }
    reportResourceProgress(onProgress, signal, "theme-write", "主题已保存", contents.length, contents.length);
    return "installed";
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
