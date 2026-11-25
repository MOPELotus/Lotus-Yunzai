import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { maxChatFileBytes } from "./chat-files.ts";
import { segment, type InboundSegment, type MessageReply, type MessageSegment } from "./messages.ts";
import { lockFile } from "./file-lock.ts";

type Scope = number | "global";
type Versions = readonly (readonly InboundSegment[])[];
type MediaType = "image" | "record" | "video";

export function isKeywordMedia(type: unknown): type is MediaType {
  return type === "image" || type === "record" || type === "video";
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSegment(value: unknown): value is InboundSegment {
  return isRecord(value) && typeof value.type === "string" && value.type.length > 0;
}

function filename(scope: Scope): string {
  if (scope !== "global" && (!Number.isSafeInteger(scope) || scope < 1)) throw new Error($t("lib.keyword-store.text_cb3d4263cf"));
  return `${scope}.json`;
}

async function snapshot(file: string) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error($t("lib.keyword-store.text_588e88a16b"));
    return { bytes: await handle.readFile(), info };
  } finally {
    await handle.close();
  }
}

function decode(bytes?: Uint8Array): Map<string, Versions> {
  if (bytes === undefined) return new Map();
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(value)) throw new Error();
    const result = new Map<string, Versions>();
    for (const [key, versions] of Object.entries(value)) {
      if (!Array.isArray(versions) || !versions.every((parts) => Array.isArray(parts) && parts.every(isSegment))) {
        throw new Error();
      }
      result.set(key, versions);
    }
    return result;
  } catch {
    throw new Error($t("lib.keyword-store.text_2659a2516d"));
  }
}

async function save(directory: string, file: string, current: Awaited<ReturnType<typeof snapshot>>, entries: Map<string, Versions>, signal?: AbortSignal) {
  const staging = await mkdtemp(join(directory, ".keywords-write-"));
  try {
    const pending = join(staging, "keywords.json");
    const handle = await open(pending, "wx", 0o600);
    try {
      const bytes = JSON.stringify(Object.fromEntries(entries), null, "\t");
      decode(new TextEncoder().encode(bytes));
      await handle.writeFile(bytes, "utf8");
      if (current) {
        const owner = await handle.stat();
        if (owner.uid !== current.info.uid || owner.gid !== current.info.gid) {
          await handle.chown(current.info.uid, current.info.gid);
        }
        await handle.chmod(current.info.mode & 0o7777);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (!current) {
      signal?.throwIfAborted();
      await link(pending, file);
      return;
    }
    const latest = await snapshot(file);
    if (!latest || current.info.ino !== latest.info.ino || current.info.dev !== latest.info.dev ||
        current.info.mode !== latest.info.mode || current.info.uid !== latest.info.uid ||
        current.info.gid !== latest.info.gid || !current.bytes.equals(latest.bytes)) {
      throw new Error($t("lib.keyword-store.text_39f2f5bd8a"));
    }
    signal?.throwIfAborted();
    await rename(pending, file);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function archiveDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (errno(error) !== "EEXIST") throw error;
  });
  if (await realpath(path) !== path || !(await stat(path)).isDirectory()) throw new Error($t("lib.keyword-store.text_04f7dc97b7"));
  return path;
}

async function archiveMedia(directory: string, scope: Scope, type: MediaType, bytes: Buffer, created: string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const parent = await archiveDirectory(await archiveDirectory(directory, String(scope)), type);
  const name = createHash("sha256").update(bytes).digest("hex");
  const path = join(parent, name);
  const staging = await mkdtemp(join(parent, ".keywords-media-"));
  try {
    const pending = join(staging, "content");
    const handle = await open(pending, "wx", 0o600);
    try {
      await handle.writeFile(bytes, { signal });
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await realpath(parent) !== parent) throw new Error($t("lib.keyword-store.text_c1d79cef59"));
    signal?.throwIfAborted();
    try {
      await link(pending, path);
      created.push(path);
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await existing.stat();
        if (!info.isFile() || info.size !== bytes.byteLength || !bytes.equals(await existing.readFile())) {
          throw new Error($t("lib.keyword-store.text_4f62c93fbf"));
        }
      } finally {
        await existing.close();
      }
    }
    return `${scope}/${type}/${name}`;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function keywordMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  if (value.startsWith("base64://")) {
    const data = value.slice("base64://".length);
    if (data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return value;
  } else if (/^https:\/\//iu.test(value) && !/[\s\u0000-\u001f\u007f\\]/u.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && !url.username && !url.password) return value;
    } catch {
      return;
    }
  }
}

function isLegacyMediaPath(parts: readonly string[], type: MediaType): boolean {
  return parts.length >= 3 && /^(?:global|[1-9]\d*)$/u.test(parts[0]!) && parts[1] === type &&
    parts.slice(2).every((part) => part !== "" && part !== "." && part !== "..");
}

async function localMedia(directory: string, type: MediaType, value: string): Promise<Uint8Array | undefined> {
  if (isAbsolute(value) || /[\\\u0000-\u001f]/u.test(value) || !isLegacyMediaPath(value.split("/"), type)) return;
  try {
    const root = await realpath(directory);
    const target = await realpath(join(root, value));
    if (!isLegacyMediaPath(relative(root, target).split(sep), type)) return;
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || !info.size) return;
      const checked = await realpath(target);
      if (!isLegacyMediaPath(relative(root, checked).split(sep), type)) return;
      const current = await stat(checked);
      if (current.ino !== info.ino || current.dev !== info.dev) return;
      const bytes = await file.readFile();
      if (bytes.byteLength) return bytes;
    } finally {
      await file.close();
    }
  } catch {
    return;
  }
}

function segmentId(value: unknown, min: number): string | number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= min) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id >= min) return value;
  }
}

export function createKeywordStore(root: URL) {
  const directory = fileURLToPath(new URL("data/messageJson/", root));

  async function read(scope: Scope): Promise<Map<string, Versions>> {
    return decode((await snapshot(join(directory, filename(scope))))?.bytes);
  }

  async function update<T>(scope: Scope,
    change: (entries: Map<string, Versions>, directory: string, created: string[]) =>
      { changed: boolean; result: T } | Promise<{ changed: boolean; result: T }>,
    signal?: AbortSignal,
  ): Promise<T> {
    const name = filename(scope);
    signal?.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const actual = await realpath(directory);
    const file = join(actual, name);
    const database = await lockFile(join(actual, ".lotus-keywords.sqlite"), $t("lib.keyword-store.text_67deafd20d"));
    const created: string[] = [];
    try {
      signal?.throwIfAborted();
      const current = await snapshot(file);
      const entries = decode(current?.bytes);
      const { changed, result } = await change(entries, actual, created);
      if (changed) await save(actual, file, current, entries, signal);
      return result;
    } catch (error) {
      await Promise.allSettled(created.map(path => rm(path, { force: true })));
      throw error;
    } finally {
      database.close();
    }
  }

  async function append(scope: Scope, key: string, parts: readonly InboundSegment[], signal?: AbortSignal): Promise<number> {
    if (typeof key !== "string" || !key.trim() || !Array.isArray(parts) || !parts.length || !parts.every(isSegment)) {
      throw new Error($t("lib.keyword-store.text_62d822ec6f"));
    }
    let total = 0;
    const pending = parts.map(part => {
      if (!isKeywordMedia(part.type) || !(part.file instanceof Uint8Array)) return part;
      total += part.file.byteLength;
      if (!part.file.byteLength || total > maxChatFileBytes) throw new Error($t("lib.keyword-store.text_d05760ad7f"));
      return { type: part.type, file: Buffer.from(part.file) };
    });
    return update(scope, async (entries, actual, created) => {
      const persisted: InboundSegment[] = [];
      for (const part of pending) {
        if (isKeywordMedia(part.type) && Buffer.isBuffer(part.file)) {
          persisted.push({ type: part.type, file: await archiveMedia(actual, scope, part.type, part.file, created, signal) });
        } else persisted.push(part);
      }
      const versions = [...entries.get(key) ?? [], persisted];
      entries.set(key, versions);
      return { changed: true, result: versions.length };
    }, signal);
  }

  async function remove(scope: Scope, key: string, index?: number): Promise<boolean> {
    if (index !== undefined && (!Number.isSafeInteger(index) || index < 1)) return false;
    return update(scope, (entries) => {
      const versions = entries.get(key);
      if (!versions || (index !== undefined && index > versions.length)) return { changed: false, result: false };
      if (index === undefined || versions.length === 1) entries.delete(key);
      else entries.set(key, versions.filter((_, i) => i !== index - 1));
      return { changed: true, result: true };
    });
  }

  async function render(parts: readonly InboundSegment[]): Promise<MessageReply | undefined> {
    const reply: MessageSegment[] = [];
    for (const part of parts) {
      const data = isRecord(part.data) ? part.data : part;
      if (part.type === "text" && typeof data.text === "string" && data.text.length) {
        reply.push(segment.text(data.text));
      } else if (part.type === "at") {
        const target = data.qq === "all" ? data.qq : segmentId(data.qq, 1);
        if (target !== undefined) reply.push(segment.at(target));
      } else if (part.type === "face") {
        const id = segmentId(data.id, 0);
        if (id !== undefined) reply.push(segment.face(id));
      } else if (isKeywordMedia(part.type)) {
        const file = typeof data.file === "string"
          ? keywordMediaUrl(data.file) ?? await localMedia(directory, part.type, data.file) : undefined;
        const media = file ?? keywordMediaUrl(data.url);
        if (media) reply.push(segment[part.type](media));
      }
    }
    return reply.length ? reply : undefined;
  }

  return { read, append, remove, render };
}
