export const maxPublicFileBytes = 16 * 1024 * 1024;
const maxTotalBytes = 64 * 1024 * 1024;
const maxFiles = 256;
const route = /^\/File\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const safeMimes = new Set([
  "application/octet-stream", "text/plain", "application/json",
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
  "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/flac",
  "video/mp4", "video/webm", "video/ogg",
]);
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

interface RegisterOptions {
  readonly name?: string;
  readonly mime?: string;
  readonly timeMs: number;
  readonly times?: number;
}

interface SharedFile {
  readonly body: Blob;
  readonly header: Headers;
  readonly createdAt: number;
  readonly timeMs: number;
  remaining?: number;
}

function downloadHeader(raw?: string): string {
  const name = (typeof raw === "string" ? raw : "").slice(0, 256).toWellFormed().replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, "_")
    .replace(/^[. ]+|[. ]+$/gu, "").trim() || "download";
  const ascii = name.replace(/[^A-Za-z0-9 ._-]/gu, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/gu, (character) =>
    "%" + character.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function expired(entry: SharedFile, now: number): boolean {
  return entry.timeMs !== 0 && now - entry.createdAt >= entry.timeMs;
}

export function createPublicFiles() {
  const files = new Map<string, SharedFile>();
  let totalBytes = 0;
  let closed = false;

  function remove(token: string, file: SharedFile) {
    files.delete(token);
    totalBytes -= file.body.size;
  }

  function register(data: Uint8Array, options: RegisterOptions): string {
    if (closed) throw new Error("文件分享服务已关闭。");
    if (!(data instanceof Uint8Array) || !ArrayBuffer.isView(data) || data.byteLength > maxPublicFileBytes) {
      throw new Error("分享内容须为大小允许的字节数据。");
    }
    const { timeMs, times, name, mime } = options;
    if (!Number.isSafeInteger(timeMs) || timeMs < 0 ||
        (times !== undefined && (!Number.isSafeInteger(times) || times < 0))) {
      throw new Error("分享有效期或访问次数无效。");
    }

    let token: string;
    do { token = crypto.randomUUID(); } while (files.has(token));
    const path = "File/" + token;
    if (times === 0) return path;

    const now = performance.now();
    for (const [id, file] of files) if (expired(file, now)) remove(id, file);
    if (files.size >= maxFiles || totalBytes + data.byteLength > maxTotalBytes) {
      throw new Error("文件分享容量已满。");
    }

    const body = new Blob([new Uint8Array(data)]);
    const type = typeof mime === "string" ? mime.trim().toLowerCase() : undefined;
    const header = new Headers({
      ...headers,
      "Content-Type": type && safeMimes.has(type) ? type : "application/octet-stream",
      "Content-Disposition": downloadHeader(name),
      "Content-Length": String(body.size),
    });
    files.set(token, { body, header, createdAt: performance.now(), timeMs, remaining: times });
    totalBytes += body.size;
    return path;
  }

  function handle(request: Request): Response | undefined {
    const { pathname, search } = new URL(request.url);
    if (pathname !== "/File" && !pathname.startsWith("/File/")) return;
    const token = search ? undefined : route.exec(pathname)?.[1];
    if (!token || closed) return new Response(null, { status: 404, headers });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    }
    const file = files.get(token);
    if (!file) return new Response(null, { status: 404, headers });
    if (expired(file, performance.now())) {
      remove(token, file);
      return new Response(null, { status: 404, headers });
    }
    if (request.method === "HEAD") return new Response(null, { headers: file.header });
    if (file.remaining !== undefined && --file.remaining === 0) remove(token, file);
    return new Response(file.body, { headers: file.header });
  }

  return {
    register,
    handle,
    close() {
      closed = true;
      files.clear();
      totalBytes = 0;
    },
  };
}
