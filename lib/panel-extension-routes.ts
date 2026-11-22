import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { attachExtensionBridge, extensionBridge, extensionTicketLifetimeMs, extensionTokenHeader } from "./panel-extension-bridge.ts";
import { dispatchGuobaApi } from "./panel-guoba-http.ts";
import { loadGuobaPages, type ExternalGuobaPage, type GuobaPage, type GuobaPages, type GuobaPageScanOptions } from "./panel-guoba-pages.ts";
import type { PluginLoadReport } from "./plugins/loader.ts";

// Allow submit handlers to run inside the frame. CSP still blocks native form requests.
const framePolicy = [
  "sandbox allow-scripts allow-forms", "default-src 'none'", "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "form-action 'none'", "frame-ancestors 'self'", "base-uri 'none'",
].join("; ");
const serviceFramePolicy = framePolicy.replace("sandbox allow-scripts allow-forms",
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox") + "; frame-src 'self'";
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
  "X-Content-Type-Options": "nosniff",
};
const assetRoot = "/panel/extensions";
const apiRoot = "/panel/extensions-api";
const bridgeRoot = "/panel/extensions-bridge";
type TicketUse = "asset" | "api";

function escapedPath(name: string): string {
  return name.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function panelExtensionRoutes(
  directories: PluginLoadReport["directories"], external?: ExternalGuobaPage, scanOptions?: GuobaPageScanOptions,
) {
  const secret = randomBytes(32);
  function snapshot(reload = false) {
    const providers = new Map(directories);
    const sources = new Map([...providers].map(([name, { path }]) => [name, path]));
    return { generation: randomUUID(), providers, registry: loadGuobaPages(sources, reload, external, scanOptions) };
  }
  let current = snapshot();
  let scanning: Promise<GuobaPages> | undefined;

  const signature = (generation: string, use: TicketUse, id: string, expires: string) =>
    createHmac("sha256", secret).update(`${generation}:${use}:${id}:${expires}`).digest();
  const mint = (generation: string, use: TicketUse, id: string, expires: string) =>
    `${expires}.${signature(generation, use, id, expires).toString("hex")}`;
  function ticketExpiry(generation: string, use: TicketUse, id: string, value: string): number {
    const [, expires, mac] = /^(\d{13})\.([0-9a-f]{64})$/u.exec(value) ?? [];
    if (!expires || !mac || !timingSafeEqual(signature(generation, use, id, expires), Buffer.from(mac, "hex"))) return 0;
    return Number(expires);
  }
  const validTicket = (generation: string, use: TicketUse, id: string, value: string) =>
    ticketExpiry(generation, use, id, value) > Date.now();
  const nextExpiry = () => String(Date.now() + extensionTicketLifetimeMs);
  const servicePreview = ({ id, plugin }: GuobaPage) => external?.servicePreview === true &&
    id === external.definition.id && plugin === external.plugin;

  function registered({ providers }: ReturnType<typeof snapshot>, plugin: string) {
    const source = providers.get(plugin);
    return external?.plugin === plugin || (source !== undefined && source === directories.get(plugin));
  }

  function catalog(source: ReturnType<typeof snapshot>, { pages, issues }: GuobaPages): Response {
    return Response.json({
      pages: pages.filter(page => registered(source, page.plugin)).map((page) => ({
        id: page.id, plugin: page.plugin, title: page.title, icon: page.icon, priority: page.priority,
        ...(servicePreview(page) && { servicePreview: true }),
      })),
      issues: issues.filter(issue => registered(source, issue.plugin)),
    });
  }

  async function list(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const source = current;
    return catalog(source, await source.registry);
  }

  async function reload(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    scanning ??= current.registry.catch(() => undefined).then(async () => {
      const next = snapshot(true);
      const initialized = await next.registry;
      current = next;
      return initialized;
    }).finally(() => { scanning = undefined; });
    await scanning;
    const source = current;
    return catalog(source, await source.registry);
  }

  async function open(request: Request, id: string): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const source = current;
    const { registry, generation } = source;
    const { pages, apis } = await registry;
    const page = pages.find((item) => item.id === id);
    const plugin = new URL(request.url).searchParams.get("plugin");
    if (!page || source !== current || !registered(source, page.plugin) || (plugin !== null && plugin !== page.plugin)) {
      return new Response(null, { status: 404 });
    }
    const expires = nextExpiry();
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

  // The management API authenticates the parent. The old ticket also binds the
  // request to the original page and registry, even if the frame was dormant.
  async function renew(request: Request, id: string): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const source = current;
    const { registry, generation } = source;
    if (!ticketExpiry(generation, "api", id, request.headers.get(extensionTokenHeader) ?? "")) {
      return new Response(null, { status: 404 });
    }
    const { pages, apis } = await registry;
    const page = pages.find((item) => item.id === id);
    if (source !== current || !page || !registered(source, page.plugin) || !apis.get(page.plugin)?.length) {
      return new Response(null, { status: 404 });
    }
    return Response.json({ token: mint(generation, "api", id, nextExpiry()) });
  }

  async function assets(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/panel/extensions/")) return;
    const [, id, ticket, encoded] = /^\/panel\/extensions\/([A-Za-z0-9_-]+)\/([^/]+)\/(.*)$/u.exec(path) ?? [];
    const source = current;
    const { registry, generation } = source;
    if (!id || !ticket || !validTicket(generation, "asset", id, ticket)) {
      return new Response(null, { status: 404, headers: frameHeaders });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { ...frameHeaders, Allow: "GET, HEAD" } });
    }
    const { pages, resolveAsset, apis } = await registry;
    const page = pages.find((item) => item.id === id);
    if (!page || source !== current || !registered(source, page.plugin)) {
      return new Response(null, { status: 404, headers: frameHeaders });
    }
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
      if (servicePreview(page)) headers["Content-Security-Policy"] = serviceFramePolicy;
      if (apis.get(page.plugin)?.length) headers["Content-Security-Policy"] += "; connect-src 'self'";
      if (request.method !== "HEAD") {
        const parents = "../".repeat(resource ? resource.split("/").length + 2 : 3);
        const src = `${parents}extensions-bridge/${id}/${ticket}`;
        body = attachExtensionBridge(typeof body === "string" ? body : await body.text(), src);
      }
    }
    if (source !== current || !registered(source, page.plugin)) return new Response(null, { status: 404, headers: frameHeaders });
    return new Response(request.method === "HEAD" ? null : body, { headers });
  }

  async function bridge(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(`${bridgeRoot}/`)) return;
    const [, id, ticket] = /^\/panel\/extensions-bridge\/([A-Za-z0-9_-]+)\/([^/]+)$/u.exec(path) ?? [];
    const source = current;
    const { registry, generation } = source;
    if (!id || !ticket || !validTicket(generation, "asset", id, ticket)) {
      return new Response(null, { status: 404, headers: frameHeaders });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { ...frameHeaders, Allow: "GET, HEAD" } });
    }
    const { pages, apis } = await registry;
    const page = pages.find((item) => item.id === id);
    if (!page || source !== current || !registered(source, page.plugin)) {
      return new Response(null, { status: 404, headers: frameHeaders });
    }
    const routes = apis.get(page.plugin);
    const script = extensionBridge(routes?.length ? {
      apiBase: `${apiRoot}/${id}`,
      relativeApi: `extensions-api/${id}`,
      legacyApiBase: `/guoba/api/custom/${encodeURIComponent(page.plugin)}`,
      // Guoba Next's custom-mount shim matches literal routes, not parameters.
      legacyRoutes: [...new Set(routes.filter(({ route }) => !route.includes(":")).map(({ route }) => route))],
    } : undefined);
    return new Response(request.method === "HEAD" ? null : script, {
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
    const source = current;
    const { registry, generation } = source;
    if (!validTicket(generation, "api", id, request.headers.get(extensionTokenHeader) ?? "")) {
      return new Response(null, { status: 401, headers: apiHeaders });
    }
    const { pages, apis } = await registry;
    const page = pages.find((item) => item.id === id);
    const routes = page && apis.get(page.plugin);
    const accepting = () => page !== undefined && source === current && registered(source, page.plugin);
    if (!routes?.length || !accepting()) return new Response(null, { status: 404, headers: apiHeaders });
    const response = await dispatchGuobaApi(request, suffix ?? "/", routes, accepting);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(apiHeaders)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  }

  return {
    api(path: string) {
      if (path === "/panel/api/extensions") return list;
      if (path === "/panel/api/extensions/reload") return reload;
      const [, id, action] = /^\/panel\/api\/extensions\/([A-Za-z0-9_-]+)\/(open|renew)$/u.exec(path) ?? [];
      return id ? (request: Request) => action === "renew" ? renew(request, id) : open(request, id) : undefined;
    },
    async assets(request: Request) {
      return await assets(request) ?? await bridge(request) ?? await invoke(request);
    },
  };
}
