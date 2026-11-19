import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { lockFile } from "./file-lock.ts";

const maxLines = 4096;
const maxCacheBytes = 4 * 1024 * 1024;
const releaseTargetPath = "data/image-previews/release-lines.json";
const pinnedRelease = {
  url: "https://github.com/palemoky/chinese-poetry-api/releases/download/v0.8.0/poetry.db.gz",
  compressedBytes: 507_948_722,
  unpackedLimit: 960_000_000,
  sha256: "8647f86276defb536038501775b5c5cf0eb8e5d8f18ea40ab0cf3ec86a176652",
} as const;

interface ImagePreviewRelease {
  readonly url: string;
  readonly compressedBytes: number;
  readonly unpackedLimit: number;
  readonly sha256: string;
}

function clean(value: unknown) {
  return typeof value === "string" ? value.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim() : "";
}

async function cachedLines(file: URL) {
  try {
    const input = Bun.file(file);
    if (!await input.exists() || input.size > maxCacheBytes) return [];
    const { lines } = await input.json();
    return Array.isArray(lines) ? lines.slice(0, maxLines).map(clean).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function contentLines(value: unknown): string[] {
  if (typeof value !== "string") return [];
  let content: unknown;
  try { content = JSON.parse(value); } catch { content = value; }
  const items = Array.isArray(content) ? content : [typeof content === "string" ? content : value];
  return items.flatMap(line => typeof line === "string" ? line.replace(/\r/gu, "\n").split(/(?<=[。！？!?；;])\s*|\n+/u)
    .map(clean).filter(Boolean) : []);
}

async function databaseLines(file: URL) {
  if (!await Bun.file(file).exists()) return [];
  const db = new Database(fileURLToPath(file), { readonly: true });
  try {
    const rows = db.query<{ title: string; author?: string; dynasty?: string; content: string }, []>(`
      SELECT p.title, p.content, a.name AS author, d.name AS dynasty
      FROM poems_zh_hans p
      LEFT JOIN authors_zh_hans a ON a.id = p.author_id
      LEFT JOIN dynasties_zh_hans d ON d.id = p.dynasty_id
      WHERE p.content IS NOT NULL AND p.content != '' ORDER BY random() LIMIT 1200
    `).iterate();
    const lines: string[] = [];
    for (const row of rows) {
      const dynasty = clean(row.dynasty);
      const title = clean(row.title);
      const source = [dynasty && `[${dynasty}]`, clean(row.author), title && `《${title}》`].filter(Boolean).join(" ");
      lines.push(...contentLines(row.content).map(line => source ? `${line} —— ${source}` : line));
      if (lines.length >= maxLines) break;
    }
    return lines.slice(0, maxLines);
  } finally {
    db.close();
  }
}

async function legacyLines(root: URL, archived = false) {
  const legacy = new URL("temp/Lotus-Plugin/poetry/", root);
  const cache = new URL("lines.json", legacy);
  const database = new URL("poetry.db", legacy);
  async function readable(file: URL) {
    if (!archived) return true;
    const path = fileURLToPath(file);
    try {
      return (await lstat(path)).isFile() && await realpath(path) === path;
    } catch {
      return false;
    }
  }
  const lines = await readable(cache) ? await cachedLines(cache) : [];
  if (lines.length || !await readable(database)) return lines;
  return databaseLines(database).catch(() => []);
}

export async function loadImagePreviews(root: URL, previous?: URL, signal?: AbortSignal): Promise<readonly string[]> {
  const target = new URL("data/image-previews/lines.json", root);
  const current = await cachedLines(target);
  if (current.length) return current;
  let lines = await legacyLines(root);
  if (!lines.length && previous) lines = await legacyLines(previous, true);
  if (!lines.length) return cachedLines(new URL(releaseTargetPath, root));
  await saveLines(target, lines, signal);
  return lines;
}

async function saveLines(target: URL, lines: readonly string[], signal?: AbortSignal) {
  const staged = new URL(`.lines-${crypto.randomUUID()}.tmp`, target);
  try {
    const content = JSON.stringify({ lines });
    if (Buffer.byteLength(content) <= maxCacheBytes) {
      await mkdir(new URL("./", target), { recursive: true });
      await writeFile(staged, content, { flag: "wx", mode: 0o600 });
      signal?.throwIfAborted();
      await link(staged, target);
    }
  } catch {
    // An existing cache or a read-only deployment can still use the source lines.
  } finally {
    await rm(staged, { force: true }).catch(() => undefined);
  }
}

async function requestRelease(url: URL, signal: AbortSignal, request: typeof fetch): Promise<Response> {
  for (let redirects = 0; redirects <= 2; redirects++) {
    if (url.protocol !== "https:" || url.port || url.username || url.password ||
        (url.hostname !== "github.com" && url.hostname !== "release-assets.githubusercontent.com")) throw new Error();
    const response = await request(url, { redirect: "manual", signal });
    if (response.ok && response.status === 200) return response;
    void response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || !location) throw new Error();
    url = new URL(location, url);
  }
  throw new Error();
}

function boundedBytes(limit: number, inspect?: (chunk: Buffer) => void) {
  let total = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.byteLength;
      if (total > limit) {
        done(new Error());
        return;
      }
      inspect?.(chunk);
      done(null, chunk);
    },
  });
  return { stream, size: () => total };
}

export async function prepareImagePreviewRelease(
  root: URL, signal: AbortSignal, request: typeof fetch = fetch, release: ImagePreviewRelease = pinnedRelease,
): Promise<readonly string[]> {
  const target = new URL(releaseTargetPath, root);
  let lock: Awaited<ReturnType<typeof lockFile>> | undefined;
  let database: URL | undefined;
  try {
    signal.throwIfAborted();
    const directory = new URL("./", target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    lock = await lockFile(fileURLToPath(new URL(".release.sqlite", directory)), "图片预览资源", 0);
    database = new URL(".release-body.sqlite", directory);
    await rm(database, { force: true });
    const existing = await cachedLines(target);
    if (existing.length) return existing;
    const response = await requestRelease(new URL(release.url), signal, request);
    if (!response.body) return [];
    const length = response.headers.get("content-length");
    if (length !== null && length !== String(release.compressedBytes)) {
      void response.body.cancel().catch(() => undefined);
      return [];
    }
    const hash = createHash("sha256");
    const compressed = boundedBytes(release.compressedBytes, chunk => hash.update(chunk));
    await pipeline(Readable.from(response.body), compressed.stream, createGunzip(), boundedBytes(release.unpackedLimit).stream,
      createWriteStream(database, { flags: "wx", mode: 0o600 }), { signal });
    if (compressed.size() !== release.compressedBytes || hash.digest("hex") !== release.sha256) return [];
    signal.throwIfAborted();
    const lines = await databaseLines(database);
    if (lines.length) await saveLines(target, lines, signal);
    return lines;
  } catch {
    // Image delivery still uses its original metadata while optional material is unavailable.
    return [];
  } finally {
    if (database) await rm(database, { force: true }).catch(() => undefined);
    lock?.close();
  }
}

export async function startImagePreviews(root: URL, signal: AbortSignal, publish: (lines: readonly string[]) => void, previous?: URL) {
  try {
    signal.throwIfAborted();
    const lines = await loadImagePreviews(root, previous, signal);
    if (signal.aborted) return;
    if (lines.length) {
      publish(lines);
      return;
    }
    await delay(120_000, undefined, { ref: false, signal });
    // Reuse a local cache created while startup was settling.
    const current = await loadImagePreviews(root, previous, signal);
    const output = current.length ? current : await prepareImagePreviewRelease(root, AbortSignal.any([signal, AbortSignal.timeout(600_000)]));
    if (output.length && !signal.aborted) publish(output);
  } catch {
    // This background load must not interrupt the host or image delivery.
  }
}
