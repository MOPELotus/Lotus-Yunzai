import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dailyNoteAssets, dailyNoteResourcePath, dailyNoteSourceRevision } from "../packages/skia/daily-note-assets.ts";
import { legacyLotusDirectories } from "./lotus-global-config.ts";
import { readMigrationSourceFile } from "./migration-files.ts";

const sourceRoots = [dailyNoteResourcePath, ...legacyLotusDirectories.map(name => join("plugins", name, "resources"))];
const raw = `https://raw.githubusercontent.com/MOPELotus/Lotus-ReFactor/${dailyNoteSourceRevision}/resources/`;
const transientDownloadErrors = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT"]);
type Asset = typeof dailyNoteAssets[number];
type Download = (url: URL, init: RequestInit) => Promise<Response>;
type Status = "installed" | "available" | "configured" | "missing" | "incomplete";

function missing(error: NodeJS.ErrnoException) {
  if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
}

function matches(bytes: Uint8Array, [, size, hash]: Asset) {
  return bytes.byteLength === size && createHash("sha256").update(bytes).digest("hex") === hash;
}

async function hasTheme(path: string) {
  return (await Promise.all(dailyNoteAssets.map(async ([asset]) => {
    const file = await stat(join(path, asset)).catch(missing);
    return file?.isFile() && file.size > 0;
  }))).every(Boolean);
}

async function localTheme(path: string): Promise<"available" | "incomplete" | undefined> {
  if (await lstat(path).catch(missing)) return await hasTheme(path) ? "available" : "incomplete";
}

async function readOriginal(asset: Asset, source: string, signal?: AbortSignal) {
  const [path, size] = asset;
  for (const directory of sourceRoots) {
    const file = await readMigrationSourceFile(source, join(source, directory, path), size, signal).catch(() => undefined);
    signal?.throwIfAborted();
    if (file && matches(file.bytes, asset)) return file.bytes;
  }
}

async function readRemote(asset: Asset, request: Download, signal: AbortSignal) {
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

function downloadOriginal(asset: Asset, request: Download, signal: AbortSignal) {
  return readRemote(asset, request, signal).catch((error: NodeJS.ErrnoException) => {
    if (!signal.aborted && transientDownloadErrors.has(error?.code ?? "")) {
      return readRemote(asset, request, signal).catch(() => undefined);
    }
  });
}

/** Prepare static artwork once, during initialization or from an existing installation copy. */
export async function prepareDailyNoteTheme(checkout: URL, {
  source = checkout, override, download, signal,
}: {
  readonly source?: URL; readonly override?: string; readonly download?: boolean | Download; readonly signal?: AbortSignal;
} = {}): Promise<Status> {
  signal?.throwIfAborted();
  if (override) return "configured";
  const root = await realpath(fileURLToPath(checkout));
  const target = join(root, dailyNoteResourcePath);
  // A complete local theme, including an administrator's linked directory, stays in use.
  const existing = await localTheme(target);
  signal?.throwIfAborted();
  if (existing) return existing;
  const donor = await realpath(fileURLToPath(source));
  const deadline = AbortSignal.timeout(30_000);
  const downloadSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const request = typeof download === "function" ? download : fetch;
  const contents: { path: string; bytes: Uint8Array }[] = [];
  for (const asset of dailyNoteAssets) {
    const bytes = await readOriginal(asset, donor, signal) ??
      (download ? await downloadOriginal(asset, request, downloadSignal) : undefined);
    signal?.throwIfAborted();
    if (!bytes) return "missing";
    contents.push({ path: asset[0], bytes });
  }

  for (const directory of [join(root, "data"), dirname(target)]) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) return "missing";
  }
  const stage = await mkdtemp(join(dirname(target), ".daily-note-theme-"));
  try {
    for (const { path, bytes } of contents) {
      const file = join(stage, path);
      await mkdir(dirname(file), { mode: 0o700, recursive: true });
      await writeFile(file, bytes, { mode: 0o600, flag: "wx", signal });
    }
    signal?.throwIfAborted();
    const concurrent = await localTheme(target);
    signal?.throwIfAborted();
    if (concurrent) return concurrent;
    try {
      await rename(stage, target);
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code === "EEXIST" || code === "ENOTEMPTY") return await localTheme(target) ?? "missing";
      throw error;
    }
    return "installed";
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
