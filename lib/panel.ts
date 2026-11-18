import { createHash, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { PluginLoadRecord } from "./plugins/loader.ts";
import { runtimeStatus } from "./server.ts";

type Endpoint = (request: Request) => Response | Promise<Response>;

export function panelApi(
  token: string,
  plugins: readonly PluginLoadRecord[],
  route?: (path: string) => Endpoint | undefined,
) {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const required = hash(`Bearer ${token}`);
  const headers = { "Cache-Control": "no-store" };

  return async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    const custom = route?.(path);
    if (!custom && path !== "/panel/api/status" && path !== "/panel/api/plugins") return;
    if (!timingSafeEqual(required, hash(request.headers.get("Authorization") ?? ""))) {
      return new Response(null, { status: 401, headers: { ...headers, "WWW-Authenticate": "Bearer" } });
    }
    if (custom) {
      const response = await custom(request);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    }
    const data = path === "/panel/api/status" ? runtimeStatus() : { plugins };
    if (request.method === "HEAD") {
      return new Response(null, { headers: { ...headers, "Content-Type": "application/json" } });
    }
    return Response.json(data, { headers });
  };
}

export async function readPanelJson(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !== "application/json" || !request.body) {
    throw new Error("请求须为 JSON。");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65_536) throw new Error("请求内容过大。");
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const assetName = /^assets\/[\w.-]+\.(?:js|css|svg|woff2)$/u;
const documentHeaders = {
  "Content-Security-Policy": [
    "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'", "img-src 'self' data:", "font-src 'self'", "frame-src 'self'",
    "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'",
  ].join("; "),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function panelAssets(directory: string) {
  return async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    if (path !== "/panel" && !path.startsWith("/panel/")) return;
    if (path.startsWith("/panel/api/")) return;

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    if (path === "/panel") return new Response(null, { status: 308, headers: { Location: "/panel/" } });
    const index = path === "/panel/";
    const name = index ? "index.html" : path.slice("/panel/".length);
    if (!index && !assetName.test(name)) return new Response(null, { status: 404 });

    try {
      const root = await realpath(directory);
      const location = await realpath(join(root, name));
      const local = relative(root, location);
      if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
        return new Response(null, { status: 404 });
      }
      const file = Bun.file(location);
      if (await file.exists()) {
        return new Response(request.method === "HEAD" ? null : file, {
          headers: {
            ...documentHeaders, "Content-Type": file.type,
            "Cache-Control": index ? "no-store" : "public, max-age=3600",
          },
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return new Response(null, { status: 500 });
      }
    }
    if (!index) return new Response(null, { status: 404 });
    return new Response(request.method === "HEAD" ? null : "面板尚未构建，请运行 bun run build:panel。", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  };
}
