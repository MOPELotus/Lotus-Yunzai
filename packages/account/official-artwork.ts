import { normalizeProfileRoleArtworkUrl } from "./role-artwork-url.ts";

type ArtworkTransport = (url: URL, init: RequestInit) => Promise<Response>;
type Size = readonly [width: number, height: number];
type RasterType = "image/png" | "image/jpeg" | "image/webp";

const maxBytes = 1024 * 1024;
const maxSide = 2048;
const maxImages = 24;
const maxConcurrent = 4;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let activeRequests = 0;

function pngSize(data: Buffer): Size | undefined {
  if (!data.subarray(0, 8).equals(pngSignature) || data.length < 33 ||
      data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") return;
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

function jpegSize(data: Buffer): Size | undefined {
  if (data[0] !== 0xff || data[1] !== 0xd8) return;
  let offset = 2;
  while (offset + 4 < data.length && data[offset++] === 0xff) {
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === undefined || marker === 0 || marker === 0xd9 || marker === 0xda || offset + 2 > data.length) return;
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return;
    const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (startOfFrame && length >= 8) return [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)];
    offset += length;
  }
}

function webpSize(data: Buffer): Size | undefined {
  if (data.length < 25 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP") return;
  const chunk = data.toString("ascii", 12, 16);
  if (chunk === "VP8X" && data.length >= 30) {
    return [data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1];
  }
  if (chunk === "VP8L" && data[20] === 0x2f) {
    const info = data.readUInt32LE(21);
    return [(info & 0x3fff) + 1, ((info >>> 14) & 0x3fff) + 1];
  }
  if (chunk === "VP8 " && data.length >= 30 && data.readUIntBE(23, 3) === 0x9d012a) {
    return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
  }
}

const imageSize: Record<RasterType, (data: Buffer) => Size | undefined> = {
  "image/png": pngSize, "image/jpeg": jpegSize, "image/webp": webpSize,
};

async function responseImage(response: Response, signal: AbortSignal): Promise<Buffer | undefined> {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const length = Number(response.headers.get("content-length"));
  if (!response.ok || response.redirected || !type || !Object.hasOwn(imageSize, type) ||
      length > maxBytes || signal.aborted) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const stop = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        stop();
        return;
      }
      chunks.push(value);
    }
    if (signal.aborted || !bytes) return;

    const data = Buffer.concat(chunks, bytes);
    const size = imageSize[type as RasterType](data);
    if (size?.every((side) => side > 0 && side <= maxSide)) return data;
  } finally {
    signal.removeEventListener("abort", stop);
    reader.releaseLock();
  }
}

async function fetchArtwork(url: string, signal: AbortSignal, transport: ArtworkTransport) {
  if (signal.aborted || activeRequests >= maxConcurrent) return;
  activeRequests++;
  try {
    const response = await transport(new URL(url), {
      method: "GET",
      headers: { Accept: "image/png, image/jpeg, image/webp" },
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    });
    return await responseImage(response, signal);
  } catch {
    return;
  } finally {
    activeRequests--;
  }
}

interface ArtworkOptions {
  readonly signal?: AbortSignal;
  readonly transport?: ArtworkTransport;
}

/** 返回以规范 URL 为键的可用官方原图。同一张卡的图片共享超时。 */
export async function loadOfficialArtwork(urls: readonly (string | undefined)[],
  { signal: cancellation, transport = fetch }: ArtworkOptions = {}): Promise<ReadonlyMap<string, Uint8Array>> {
  const requested = new Set<string>();
  for (const value of urls) {
    const url = normalizeProfileRoleArtworkUrl(value);
    if (url) requested.add(url);
    if (requested.size >= maxImages) break;
  }
  const result = new Map<string, Uint8Array>();
  if (!requested.size || cancellation?.aborted) return result;

  const deadline = AbortSignal.timeout(3_000);
  const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline;
  const pending = requested.values();
  await Promise.all(Array.from({ length: Math.min(maxConcurrent, requested.size) }, async () => {
    for (const url of pending) {
      if (signal.aborted) break;
      const image = await fetchArtwork(url, signal, transport);
      if (image) result.set(url, image);
    }
  }));
  return result;
}
