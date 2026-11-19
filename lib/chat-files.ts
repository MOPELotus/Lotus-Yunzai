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

export async function readQqMessageMedia(value: unknown, signal?: AbortSignal): Promise<Uint8Array | undefined> {
  const url = qqResourceUrl(value);
  if (!url || typeof value !== "string" || /[\\\s]/u.test(value)) return;
  const { hostname, pathname } = url;
  const qqImage = (hostname === "gchat.qpic.cn" && (pathname === "/download" || pathname.startsWith("/gchatpic_new/"))) ||
    (hostname === "c2cpicdw.qpic.cn" && pathname.startsWith("/offpic_new/"));
  if (!qqFileHost(url) && !qqImage) return;
  const bytes = await readQqResource(url, undefined, signal, true);
  if (!bytes) return;
  const prefix = new TextDecoder().decode(bytes.subarray(0, 128));
  if (!/^\s*(?:<!doctype html|<html\b|<\?xml|\{|\[)/iu.test(prefix)) return bytes;
}

async function readQqResource(url: URL, size?: number, signal?: AbortSignal, media = false) {
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
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxChatFileBytes || textual) {
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
      if (sizeRead > (size ?? maxChatFileBytes)) return;
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
