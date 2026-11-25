import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeChatFileBytes, maxChatFileBytes } from "./chat-files.ts";
import { createKeywordStore, isKeywordMedia, keywordMediaUrl } from "./keyword-store.ts";
import type { InboundSegment } from "./messages.ts";
import { withinInstallation } from "./plugins/migration-plan.ts";

const directory = "data/messageJson";
const backup = "backup/legacy-keywords";
const maxArchiveBytes = 64 * 1024 * 1024;
const maxScopeBytes = 32 * 1024 * 1024;

async function named(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function matches(previous: Stats, current: Stats | undefined) {
  return current && previous.dev === current.dev && previous.ino === current.ino && previous.size === current.size &&
    previous.mode === current.mode && previous.nlink === current.nlink && previous.mtimeMs === current.mtimeMs && previous.ctimeMs === current.ctimeMs;
}

function changed() {
  return new Error($t("lib.migration-keywords.text_0a60b02527"));
}

function scope(value: string): "global" | number | undefined {
  if (value === "global") return value;
  if (/^[1-9]\d{0,15}$/u.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
}

function scopeFile(path: string) {
  return path.endsWith(".json") ? scope(path.slice(0, -5)) : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function segment(value: unknown): value is InboundSegment {
  return record(value) && typeof value.type === "string" && value.type.length > 0;
}

function readScope(bytes: Buffer) {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return; }
  if (!record(raw)) return;
  const entries = new Map<string, InboundSegment[][]>();
  let normalized = 0, rejected = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value) && value.every(item => Array.isArray(item) && item.every(segment))) {
      entries.set(key, value);
    } else if (Array.isArray(value) && value.every(segment)) {
      // The old Mora list interpreted a flat array in the active TRSS directory as a single version.
      entries.set(key, [value]);
      normalized++;
    } else rejected++;
  }
  const active = normalized || rejected ? JSON.stringify(Object.fromEntries(entries), null, "\t") : bytes;
  return { entries, active, normalized, rejected };
}

async function readFileSnapshot(path: string, expected: Stats, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (await realpath(path) !== path) throw changed();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!matches(expected, await file.stat())) throw changed();
    const bytes = Buffer.alloc(expected.size);
    for (let offset = 0; offset < bytes.length;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    if (!matches(expected, await file.stat()) || !matches(expected, await named(path)) || await realpath(path) !== path) throw changed();
    return bytes;
  } finally { await file.close(); }
}

function supportedReference(value: unknown) {
  const url = keywordMediaUrl(value);
  return !!url && (!url.startsWith("base64://") || !!decodeChatFileBytes(url));
}

function referencedFile(type: string, value: unknown): string | undefined {
  if (typeof value !== "string" || /[\\\u0000-\u001f]/u.test(value)) return;
  const [owner, folder, ...parts] = value.split("/");
  if (owner !== undefined && scope(owner) !== undefined && folder === type && parts.length &&
      parts.every(part => !!part && part !== "." && part !== "..")) {
    return value;
  }
}

/** Copies the TRSS store into a private staging tree without consulting dormant data/textJson or fetching media URLs. */
export async function stageLegacyKeywords(sourcePath: string, stateDirectory: string, signal?: AbortSignal) {
  const [source, destination] = await Promise.all([realpath(sourcePath), realpath(stateDirectory)]);
  const stage = await lstat(destination);
  if (withinInstallation(source, destination) || withinInstallation(destination, source) || !(await lstat(source)).isDirectory() ||
      destination !== resolve(stateDirectory) || !stage.isDirectory() || (stage.mode & 0o077)) {
    throw new Error($t("lib.migration-keywords.text_79065d8213"));
  }
  const result = { scopes: 0, keywords: 0, media: 0, archived: 0, unresolvedMedia: 0, normalizedKeywords: 0,
    rejectedScopes: 0, rejectedKeywords: 0, skippedFiles: 0 };
  const root = join(source, directory);
  const directories = new Map<string, Stats>();
  const files = new Map<string, Stats>();
  async function readDirectoryInfo(path: string) {
    const info = await named(path);
    if (!info) return false;
    if (!info.isDirectory() || await realpath(path) !== path) throw new Error($t("lib.migration-keywords.text_261aae67bb"));
    directories.set(path, info);
    return true;
  }
  signal?.throwIfAborted();
  if (!await readDirectoryInfo(join(source, "data")) || !await readDirectoryInfo(root)) return result;

  async function inventory(parent: string) {
    for (const entry of (await readdir(join(root, parent))).sort()) {
      signal?.throwIfAborted();
      if (entry === ".lotus-keywords.sqlite" || entry === ".lotus-keywords.sqlite-shm" || entry === ".lotus-keywords.sqlite-wal" ||
          entry.startsWith(".keywords-write-") || entry.startsWith(".keywords-media-")) continue;
      const local = parent ? `${parent}/${entry}` : entry;
      const path = join(root, local);
      const info = await named(path);
      if (!info) throw changed();
      const book = scopeFile(local);
      if (info.isDirectory() && book === undefined) {
        if (!await readDirectoryInfo(path)) throw changed();
        await inventory(local);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) {
        if (book !== undefined) throw new Error($t("lib.migration-keywords.text_e4bf9ac236"));
        result.skippedFiles++;
        continue;
      }
      if (info.size > maxArchiveBytes) {
        result.skippedFiles++;
        if (book !== undefined) result.rejectedScopes++;
        continue;
      }
      files.set(local, info);
    }
  }
  await inventory("");

  async function ensureDirectory(path: string) {
    if (path === destination) return;
    await ensureDirectory(dirname(path));
    if (!await named(path)) await mkdir(path, { mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || (info.mode & 0o077) || await realpath(path) !== path) throw new Error($t("lib.migration-keywords.text_26d9afe9e7"));
  }
  async function write(path: string, bytes: Buffer | string) {
    signal?.throwIfAborted();
    const full = join(destination, path);
    await ensureDirectory(dirname(full));
    await writeFile(full, bytes, { mode: 0o600, flag: "wx", signal });
  }

  const referenced = new Set<string>();
  const books: (number | "global")[] = [];
  for (const [path, info] of files) {
    const id = scopeFile(path);
    if (id === undefined) continue;
    const bytes = await readFileSnapshot(join(root, path), info, signal);
    await write(join(backup, path), bytes);
    result.archived++;
    const book = info.size <= maxScopeBytes ? readScope(bytes) : undefined;
    if (!book) { result.rejectedScopes++; continue; }
    result.normalizedKeywords += book.normalized;
    result.rejectedKeywords += book.rejected;
    for (const versions of book.entries.values()) for (const parts of versions) for (const part of parts) {
      if (!isKeywordMedia(part.type)) continue;
      const data = record(part.data) ? part.data : part;
      if (supportedReference(data.file)) continue;
      const found = referencedFile(part.type, data.file);
      const asset = found !== undefined ? files.get(found) : undefined;
      if (found && asset && asset.size > 0 && asset.size <= maxChatFileBytes) referenced.add(found);
      else if (!supportedReference(data.url)) result.unresolvedMedia++;
    }
    await write(join(directory, path), book.active);
    books.push(id);
    result.scopes++;
    result.keywords += book.entries.size;
  }

  for (const [path, info] of files) {
    if (scopeFile(path) !== undefined) continue;
    const bytes = await readFileSnapshot(join(root, path), info, signal);
    if (referenced.has(path)) {
      await write(join(directory, path), bytes);
      result.media++;
    } else {
      await write(join(backup, path), bytes);
      result.archived++;
    }
  }
  for (const [path, info] of directories) {
    if (!matches(info, await named(path)) || await realpath(path) !== path) throw changed();
  }
  for (const [path, info] of files) {
    if (!matches(info, await named(join(root, path)))) throw changed();
  }
  const reader = createKeywordStore(pathToFileURL(destination + "/"));
  for (const id of books) await reader.read(id);
  return result;
}
