export interface ChatFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type ChatFileResult = "confirmed" | "rejected" | "unknown";

export interface IncomingChatFile {
  readonly name: string;
  readonly size?: number;
  read(signal?: AbortSignal): Promise<Uint8Array | undefined>;
}

export const chatFileRelaySource = Symbol("chatFileRelaySource");
export interface ChatFileRelaySource {
  readonly signal: AbortSignal;
  readonly reference: string;
  readonly notice?: true;
  readonly relayOnly?: true;
  readonly reservation?: symbol;
}

export const maxChatFileBytes = 16 * 1024 * 1024;

export function isChatFileName(name: unknown): name is string {
  return typeof name === "string" && !!name.trim() && name.isWellFormed() && name !== "." && name !== ".." &&
    !/[/\\\u0000-\u001f\u007f\u2028\u2029]/u.test(name) && Buffer.byteLength(name) <= 255;
}

function isFileSize(size: number, expected?: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && size <= maxChatFileBytes && (expected === undefined || size === expected);
}

export function encodeChatFile({ name, bytes }: ChatFile): string | undefined {
  if (!isChatFileName(name) || !(bytes instanceof Uint8Array) || !isFileSize(bytes.byteLength)) return;
  return `base64://${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`;
}

export function decodeChatFileBytes(value: unknown, size?: number): Uint8Array | undefined {
  if (typeof value !== "string" || value.length > Math.ceil(maxChatFileBytes / 3) * 4 + "base64://".length) return;
  const encoded = value.startsWith("base64://") ? value.slice("base64://".length) : value;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 === 1 ||
      (encoded.endsWith("=") && encoded.length % 4 !== 0)) return;
  const bytes = Buffer.from(encoded, "base64");
  if (isFileSize(bytes.byteLength, size)) return bytes;
}

function qqResourceUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 8192) return;
  const url = URL.parse(value);
  if (url?.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash) return url;
}

function qqFileHost(url: URL) {
  return [".qq.com", ".qq.com.cn"].some(suffix => url.hostname.endsWith(suffix));
}

export async function readQqChatFile(value: unknown, size?: number, signal?: AbortSignal): Promise<Uint8Array | undefined> {
  const url = qqResourceUrl(value);
  if (!url || !qqFileHost(url) || (size !== undefined && !isFileSize(size))) return;
  return readQqResource(url, size, signal);
}

export async function readQqMessageMedia(value: unknown, signal?: AbortSignal, maxBytes = maxChatFileBytes): Promise<Uint8Array | undefined> {
  const url = qqResourceUrl(value);
  if (!url || typeof value !== "string" || /[\\\s]/u.test(value)) return;
  const { hostname, pathname } = url;
  const qqImage = (hostname === "gchat.qpic.cn" && (pathname === "/download" || pathname.startsWith("/gchatpic_new/"))) ||
    (hostname === "c2cpicdw.qpic.cn" && pathname.startsWith("/offpic_new/"));
  if (!qqFileHost(url) && !qqImage) return;
  const bytes = await readQqResource(url, undefined, signal, true, maxBytes);
  if (!bytes) return;
  const prefix = new TextDecoder().decode(bytes.subarray(0, 128));
  if (!/^\s*(?:<!doctype html|<html\b|<\?xml|\{|\[)/iu.test(prefix)) return bytes;
}

function qqImageSource(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192 || /[\s\\]/u.test(value)) return false;
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
  const { hostname, pathname } = url;
  if (hostname === "gchat.qpic.cn") return pathname === "/download" || pathname.startsWith("/gchatpic_new/");
  if (hostname === "c2cpicdw.qpic.cn") return pathname.startsWith("/offpic_new/");
  return hostname === "multimedia.nt.qq.com.cn" && pathname === "/download";
}

export async function readQqMessageImage(part: Readonly<Record<string, unknown>>, signal: AbortSignal, options?: { maxBytes: number; fallback?: unknown }) {
  return (await readQqMessageImageSource(part, signal, options))?.data;
}

export async function readQqMessageImageSource(part: Readonly<Record<string, unknown>>, signal: AbortSignal, options?: { maxBytes: number; fallback?: unknown }) {
  const url = part.url ?? options?.fallback;
  if (qqImageSource(url)) {
    const image = await readQqMessageMedia(url, signal, options?.maxBytes);
    if (image) return { data: image, url };
  }
  const download = part.getDownloadUrl;
  if (signal.aborted || typeof download !== "function") return;
  const renewed: unknown = await Promise.resolve().then(() => download()).catch(() => undefined);
  if (qqImageSource(renewed) && renewed !== url) {
    const data = await readQqMessageMedia(renewed, signal, options?.maxBytes);
    if (data) return { data, url: renewed };
  }
}

export async function readQqMessageSegmentMedia(part: Readonly<Record<string, unknown>>, signal: AbortSignal) {
  if (signal.aborted) return;
  const original = typeof part.url === "string" ? part.url : undefined;
  if (original !== undefined) {
    const bytes = await readQqMessageMedia(original, signal);
    if (bytes || signal.aborted) return bytes;
  }
  if (typeof part.getDownloadUrl !== "function") {
    if (original === undefined) return readQqMessageMedia(part.file, signal);
    return;
  }
  try {
    const refreshed: unknown = await part.getDownloadUrl();
    if (refreshed !== original && !signal.aborted) return readQqMessageMedia(refreshed, signal);
  } catch { return; }
}

async function readQqResource(url: URL, size?: number, signal?: AbortSignal, media = false, maxBytes = maxChatFileBytes) {
  const timeout = AbortSignal.timeout(30_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    deadline.throwIfAborted();
    const response = await fetch(url, {
      redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: deadline,
    });
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    const textual = media && /^(?:text\/|application\/(?:[a-z0-9.-]+\+)?(?:json|xml)$)/iu.test(mediaType);
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxBytes || textual) {
      await response.body?.cancel();
      return;
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let sizeRead = 0;
    for (;;) {
      deadline.throwIfAborted();
      const { done, value: chunk } = await reader.read();
      if (done) break;
      sizeRead += chunk.byteLength;
      if (sizeRead > (size ?? maxBytes)) return;
      chunks.push(chunk);
    }
    deadline.throwIfAborted();
    if (isFileSize(sizeRead, size)) return Buffer.concat(chunks, sizeRead);
  } catch {
    return;
  } finally {
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
