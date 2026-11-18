import { createHash, timingSafeEqual } from "node:crypto";
import type { PluginLoadRecord } from "./plugins/loader.ts";
import { runtimeStatus } from "./server.ts";

export function panelApi(token: string, plugins: readonly PluginLoadRecord[]) {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const required = hash(`Bearer ${token}`);
  const headers = { "Cache-Control": "no-store" };

  return (request: Request): Response | undefined => {
    const path = new URL(request.url).pathname;
    if (path !== "/panel/api/status" && path !== "/panel/api/plugins") return;
    if (!timingSafeEqual(required, hash(request.headers.get("Authorization") ?? ""))) {
      return new Response(null, { status: 401, headers: { ...headers, "WWW-Authenticate": "Bearer" } });
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
