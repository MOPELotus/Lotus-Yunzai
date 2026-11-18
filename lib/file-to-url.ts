import { maxPublicFileBytes, type createPublicFiles } from "./public-files.ts";

interface FileOptions {
  readonly name?: string;
  readonly mime?: string;
  readonly time?: number | null | false;
  readonly times?: number | null | false;
}

type FileData = Uint8Array | ArrayBuffer | Blob | string | URL;
type FileInput = FileData | {
  readonly buffer: FileData;
  readonly name?: string;
  readonly mime?: string;
  readonly type?: { readonly mime?: string };
};

const defaultTimeMs = 60_000;
const maxEncodedLength = Math.ceil(maxPublicFileBytes / 3) * 4;
const numberText = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;

function numeric(value: unknown): number | undefined {
  const input = typeof value === "string" && numberText.test(value.trim()) ? Number(value) : value;
  if (typeof input === "number" && Number.isFinite(input)) return input;
}

function defaultTime(value: unknown): number {
  if (value === null || value === false || value === "") return 0;
  const minutes = numeric(value);
  const timeMs = minutes === undefined ? defaultTimeMs : Math.ceil(minutes * 60_000);
  return Number.isSafeInteger(timeMs) && timeMs >= 0 ? timeMs : defaultTimeMs;
}

function hitLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === false || value === "") return;
  const limit = numeric(value);
  if (limit === undefined || !Number.isSafeInteger(Math.ceil(limit))) return 0;
  return Math.max(0, Math.ceil(limit));
}

function isBytes(value: FileInput): value is Uint8Array | ArrayBuffer | Blob {
  return value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Blob;
}

function remoteLink(value: string): boolean {
  if (!/^https?:\/\//iu.test(value) || !URL.canParse(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password;
}

function decodeFile(value: string): { bytes: Uint8Array; mime?: string } {
  const dataUrl = /^data:([^;,]*);base64,/iu.exec(value);
  const prefix = dataUrl?.[0] ?? (value.startsWith("base64://") ? "base64://" : undefined);
  if (prefix === undefined) throw new TypeError("请传入文件内容、Base64 或 HTTP(S) 链接。");
  const length = value.length - prefix.length;
  if (length > maxEncodedLength) throw new RangeError("需分享的文件过大。");
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) ||
      (encoded.includes("=") ? length % 4 !== 0 : length % 4 === 1)) {
    throw new TypeError("文件 Base64 格式无效。");
  }
  return { bytes: Buffer.from(encoded, "base64"), mime: dataUrl?.[1] };
}

const rasterSignatures = [
  { mime: "image/png", extension: "png", bytes: [137, 80, 78, 71, 13, 10, 26, 10] },
  { mime: "image/jpeg", extension: "jpg", bytes: [255, 216, 255] },
  { mime: "image/gif", extension: "gif", bytes: [71, 73, 70, 56, 55, 97] },
  { mime: "image/gif", extension: "gif", bytes: [71, 73, 70, 56, 57, 97] },
] as const;

function rasterFile(bytes: Uint8Array): { mime: string; extension: string } | undefined {
  if ([82, 73, 70, 70].every((byte, index) => bytes[index] === byte) &&
      [87, 69, 66, 80].every((byte, index) => bytes[index + 8] === byte)) {
    return { mime: "image/webp", extension: "webp" };
  }
  return rasterSignatures.find((signature) => signature.bytes.every((byte, index) => bytes[index] === byte));
}

export function createFileToUrl(
  files: ReturnType<typeof createPublicFiles>, config: Record<string, unknown>, baseUrl: () => URL | undefined,
) {
  const timeMs = defaultTime(config.file_to_url_time);
  const times = hitLimit(config.file_to_url_times);
  return async (input: FileInput, options: FileOptions = {}): Promise<URL | string> => {
    const object = typeof input === "object" && input !== null && !isBytes(input) && !(input instanceof URL)
      ? input : undefined;
    const data: FileData = object ? object.buffer : input as FileData;
    if (typeof data === "string" && remoteLink(data)) return data;
    if (data instanceof URL && remoteLink(data.href)) return data.href;

    const base = baseUrl();
    if (!base) throw new Error("公共 HTTP 地址未就绪，请配置 server.url 或在启动后分享文件。");
    const duration = options.time === undefined ? timeMs : options.time === null || options.time === false ? 0 : options.time;
    if (!Number.isFinite(duration) || duration < 0 || !Number.isSafeInteger(Math.ceil(duration))) {
      throw new RangeError("文件有效期须为有效的非负毫秒数。");
    }

    let bytes: Uint8Array;
    let mime: string | undefined;
    if (data instanceof Uint8Array) {
      bytes = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Blob) {
      if (data.size > maxPublicFileBytes) throw new RangeError("需分享的文件过大。");
      bytes = new Uint8Array(await data.arrayBuffer());
      mime = data.type;
    } else if (typeof data === "string") {
      ({ bytes, mime } = decodeFile(data));
    } else {
      throw new TypeError("请传入文件内容、Base64 或 HTTP(S) 链接。");
    }

    const raster = rasterFile(bytes);
    const path = files.register(bytes, {
      name: options.name ?? object?.name ?? (data instanceof File ? data.name : undefined) ??
        (raster && `file.${raster.extension}`),
      mime: options.mime ?? object?.mime ?? object?.type?.mime ?? (mime || raster?.mime),
      timeMs: Math.ceil(duration),
      times: options.times === undefined ? times : hitLimit(options.times),
    });
    return new URL(path, base);
  };
}

export type FileToUrl = ReturnType<typeof createFileToUrl>;

export function listenerFileBase(hostname: string, port: number | undefined, protocol: "http" | "https" = "http"): URL | undefined {
  if (!port) return;
  const host = hostname === "0.0.0.0" ? "127.0.0.1"
    : hostname === "::" || hostname === "[::]" ? "[::1]"
    : hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  const origin = `${protocol}://${host}:${port}/`;
  const url = URL.parse(origin);
  if (url && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) return url;
}
