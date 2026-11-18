import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { loadGuobaPages } from "./panel-guoba-pages.ts";
import type { PluginLoadReport } from "./plugins/loader.ts";

const framePolicy = [
  "sandbox allow-scripts", "default-src 'none'", "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "form-action 'none'", "frame-ancestors 'self'", "base-uri 'none'",
].join("; ");
const frameHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": framePolicy,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function escapedPath(name: string): string {
  return name.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function panelExtensionRoutes(directories: PluginLoadReport["directories"]) {
  const secret = randomBytes(32);
  const sources = new Map([...directories].map(([name, { path }]) => [name, path]));
  const registry = loadGuobaPages(sources);

  const signature = (id: string, expires: string) => createHmac("sha256", secret).update(`${id}:${expires}`).digest();
  function validTicket(id: string, value: string): boolean {
    const [, expires, mac] = /^(\d{13})\.([0-9a-f]{64})$/u.exec(value) ?? [];
    return expires !== undefined && mac !== undefined && Number(expires) > Date.now() &&
      timingSafeEqual(signature(id, expires), Buffer.from(mac, "hex"));
  }

  async function list(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const { pages, issues } = await registry;
    return Response.json({
      pages: pages.map(({ id, plugin, title, icon, priority }) => ({ id, plugin, title, icon, priority })),
      issues,
    });
  }

  async function open(request: Request, id: string): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const { pages } = await registry;
    const page = pages.find((item) => item.id === id);
    if (!page) return new Response(null, { status: 404 });
    const expires = String(Date.now() + 5 * 60_000);
    const ticket = `${expires}.${signature(id, expires).toString("hex")}`;
    return Response.json({ url: `/panel/extensions/${id}/${ticket}/${page.src ? escapedPath(page.src) : ""}` });
  }

  async function assets(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/panel/extensions/")) return;
    const [, id, ticket, encoded] = /^\/panel\/extensions\/([A-Za-z0-9_-]+)\/([^/]+)\/(.*)$/u.exec(path) ?? [];
    if (!id || !ticket || !validTicket(id, ticket)) return new Response(null, { status: 404, headers: frameHeaders });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { ...frameHeaders, Allow: "GET, HEAD" } });
    }
    const { pages, resolveAsset } = await registry;
    const page = pages.find((item) => item.id === id);
    if (!page) return new Response(null, { status: 404, headers: frameHeaders });
    let resource: string;
    try {
      resource = decodeURIComponent(encoded ?? "");
    } catch {
      return new Response(null, { status: 404, headers: frameHeaders });
    }

    let body: string | Blob;
    let type: string;
    if (!resource && page.html !== undefined) {
      const css = page.style ? `<link rel="stylesheet" href="${escapedPath(page.style)}">` : "";
      const script = page.script ? `<script src="${escapedPath(page.script)}"></script>` : "";
      body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css}${page.html}${script}`;
      type = "text/html; charset=utf-8";
    } else {
      const asset = await resolveAsset(id, resource);
      if (!asset) return new Response(null, { status: 404, headers: frameHeaders });
      const file = Bun.file(asset.path);
      if (!await file.exists()) return new Response(null, { status: 404, headers: frameHeaders });
      body = file;
      type = asset.isEntry ? "text/html; charset=utf-8" : file.type;
    }
    return new Response(request.method === "HEAD" ? null : body, {
      headers: { ...frameHeaders, "Content-Type": type },
    });
  }

  return {
    api(path: string) {
      if (path === "/panel/api/extensions") return list;
      const id = /^\/panel\/api\/extensions\/([A-Za-z0-9_-]+)\/open$/u.exec(path)?.[1];
      return id ? (request: Request) => open(request, id) : undefined;
    },
    assets,
  };
}
