import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { attachExtensionBridge, extensionBridge, extensionTokenHeader } from "./panel-extension-bridge.ts";
import { dispatchGuobaApi } from "./panel-guoba-http.ts";
import { loadGuobaPages, type GuobaPages } from "./panel-guoba-pages.ts";
import type { PluginLoadReport } from "./plugins/loader.ts";

// Allow submit handlers to run inside the frame. CSP still blocks native form requests.
const framePolicy = [
  "sandbox allow-scripts allow-forms", "default-src 'none'", "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "form-action 'none'", "frame-ancestors 'self'", "base-uri 'none'",
].join("; ");
const frameHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": framePolicy,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const apiHeaders = {
  "Access-Control-Allow-Origin": "null",
  "Cache-Control": "no-store",
  "Vary": "Origin",
};
const assetRoot = "/panel/extensions";
const apiRoot = "/panel/extensions-api";
const bridgeRoot = "/panel/extensions-bridge";
type TicketUse = "asset" | "api";

function escapedPath(name: string): string {
  return name.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function panelExtensionRoutes(directories: PluginLoadReport["directories"]) {
  const secret = randomBytes(32);
  const sources = new Map([...directories].map(([name, { path }]) => [name, path]));
  function snapshot(reload = false) {
    return { generation: randomUUID(), registry: loadGuobaPages(sources, reload) };
  }
  let current = snapshot();
  let scanning: Promise<GuobaPages> | undefined;

  const signature = (generation: string, use: TicketUse, id: string, expires: string) =>
    createHmac("sha256", secret).update(`${generation}:${use}:${id}:${expires}`).digest();
  const mint = (generation: string, use: TicketUse, id: string, expires: string) =>
    `${expires}.${signature(generation, use, id, expires).toString("hex")}`;
  function validTicket(generation: string, use: TicketUse, id: string, value: string): boolean {
    const [, expires, mac] = /^(\d{13})\.([0-9a-f]{64})$/u.exec(value) ?? [];
    return expires !== undefined && mac !== undefined && Number(expires) > Date.now() &&
      timingSafeEqual(signature(generation, use, id, expires), Buffer.from(mac, "hex"));
  }

  function catalog({ pages, issues }: GuobaPages): Response {
    return Response.json({
      pages: pages.map(({ id, plugin, title, icon, priority }) => ({ id, plugin, title, icon, priority })),
      issues,
    });
  }

  async function list(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    return catalog(await current.registry);
  }

  async function reload(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    scanning ??= current.registry.catch(() => undefined).then(async () => {
      const next = snapshot(true);
      const initialized = await next.registry;
      current = next;
      return initialized;
    }).finally(() => { scanning = undefined; });
    return catalog(await scanning);
  }

  async function open(request: Request, id: string): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const { registry, generation } = current;
    const { pages, apis } = await registry;
    const page = pages.find((item) => item.id === id);
    if (!page) return new Response(null, { status: 404 });
    const expires = String(Date.now() + 5 * 60_000);
    const ticket = mint(generation, "asset", id, expires);
    const url = `${assetRoot}/${id}/${ticket}/${page.src ? escapedPath(page.src) : ""}`;
    if (!apis.get(page.plugin)?.length) return Response.json({ url });
    const search = new URLSearchParams({
      __apiBase: `${apiRoot}/${id}`,
      __webBase: "/guoba",
      token: mint(generation, "api", id, expires),
    });
    return Response.json({ url: `${url}?${search}` });
  }

  async function assets(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/panel/extensions/")) return;
    const [, id, ticket, encoded] = /^\/panel\/extensions\/([A-Za-z0-9_-]+)\/([^/]+)\/(.*)$/u.exec(path) ?? [];
    const { registry, generation } = current;
    if (!id || !ticket || !validTicket(generation, "asset", id, ticket)) {
      return new Response(null, { status: 404, headers: frameHeaders });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { ...frameHeaders, Allow: "GET, HEAD" } });
    }
    const { pages, resolveAsset, apis } = await registry;
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
    let isFrame = false;
    if (!resource && page.html !== undefined) {
      const css = page.style ? `<link rel="stylesheet" href="${escapedPath(page.style)}">` : "";
      const script = page.script ? `<script src="${escapedPath(page.script)}"></script>` : "";
      body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css}${page.html}${script}`;
      type = "text/html; charset=utf-8";
      isFrame = true;
    } else {
      const asset = await resolveAsset(id, resource);
      if (!asset) return new Response(null, { status: 404, headers: frameHeaders });
      const file = Bun.file(asset.path);
      if (!await file.exists()) return new Response(null, { status: 404, headers: frameHeaders });
      body = file;
      type = asset.isEntry ? "text/html; charset=utf-8" : file.type;
      isFrame = asset.isEntry;
    }
    const headers = { ...frameHeaders, "Content-Type": type };
    if (isFrame) {
      if (apis.get(page.plugin)?.length) headers["Content-Security-Policy"] += "; connect-src 'self'";
      if (request.method !== "HEAD") {
        const src = `${bridgeRoot}/${id}/${ticket}`;
        body = attachExtensionBridge(typeof body === "string" ? body : await body.text(), src);
      }
    }
    return new Response(request.method === "HEAD" ? null : body, {
      headers,
    });
  }

  async function bridge(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(`${bridgeRoot}/`)) return;
    const [, id, ticket] = /^\/panel\/extensions-bridge\/([A-Za-z0-9_-]+)\/([^/]+)$/u.exec(path) ?? [];
    const { registry, generation } = current;
    if (!id || !ticket || !validTicket(generation, "asset", id, ticket)) {
      return new Response(null, { status: 404, headers: frameHeaders });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { ...frameHeaders, Allow: "GET, HEAD" } });
    }
    const { pages, apis } = await registry;
    const page = pages.find((item) => item.id === id);
    if (!page) return new Response(null, { status: 404, headers: frameHeaders });
    const source = extensionBridge(apis.get(page.plugin)?.length ? {
      apiBase: `${apiRoot}/${id}`,
      legacyApiBase: `/guoba/api/custom/${encodeURIComponent(page.plugin)}`,
    } : undefined);
    return new Response(request.method === "HEAD" ? null : source, {
      headers: { ...frameHeaders, "Content-Type": "text/javascript; charset=utf-8" },
    });
  }

  async function invoke(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(`${apiRoot}/`)) return;
    const [, id, suffix] = /^\/panel\/extensions-api\/([A-Za-z0-9_-]+)(\/.*)?$/u.exec(path) ?? [];
    if (!id || request.headers.get("Origin") !== "null") return new Response(null, { status: 403 });
    if (request.method === "OPTIONS") {
      const method = request.headers.get("Access-Control-Request-Method") ?? "";
      const headers = request.headers.get("Access-Control-Request-Headers")?.toLowerCase().split(/\s*,\s*/u) ?? [];
      const methods = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"];
      if (!methods.includes(method) || headers.some((name) => name !== "content-type" && name !== extensionTokenHeader)) {
        return new Response(null, { status: 403, headers: apiHeaders });
      }
      return new Response(null, { status: 204, headers: {
        ...apiHeaders, "Access-Control-Allow-Methods": methods.join(", "),
        "Access-Control-Allow-Headers": `content-type, ${extensionTokenHeader}`,
      } });
    }
    const { registry, generation } = current;
    if (!validTicket(generation, "api", id, request.headers.get(extensionTokenHeader) ?? "")) {
      return new Response(null, { status: 401, headers: apiHeaders });
    }
    const { pages, apis } = await registry;
    const page = pages.find((item) => item.id === id);
    const routes = page && apis.get(page.plugin);
    if (!routes?.length) return new Response(null, { status: 404, headers: apiHeaders });
    const response = await dispatchGuobaApi(request, suffix ?? "/", routes);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(apiHeaders)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  }

  return {
    api(path: string) {
      if (path === "/panel/api/extensions") return list;
      if (path === "/panel/api/extensions/reload") return reload;
      const id = /^\/panel\/api\/extensions\/([A-Za-z0-9_-]+)\/open$/u.exec(path)?.[1];
      return id ? (request: Request) => open(request, id) : undefined;
    },
    async assets(request: Request) {
      return await assets(request) ?? await bridge(request) ?? await invoke(request);
    },
  };
}
