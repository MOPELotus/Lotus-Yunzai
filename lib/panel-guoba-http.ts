import { readPanelJson } from "./panel.ts";

export interface GuobaApiRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Record<string, string>;
  readonly query: Record<string, string | string[]>;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string | undefined>>;
  get(name: string): string | undefined;
}

export interface GuobaApiResponse {
  readonly headersSent: boolean;
  setHeader(name: string, value: string | number | readonly string[]): GuobaApiResponse;
  status(code: number): GuobaApiResponse;
  json(data?: unknown): GuobaApiResponse;
  send(data?: unknown): GuobaApiResponse;
  end(): GuobaApiResponse;
}

export type GuobaApiHandler = (
  request: GuobaApiRequest,
  response: GuobaApiResponse,
  next: (error?: unknown) => void,
) => unknown;

export interface GuobaApiDefinition {
  readonly method: string;
  readonly route: string;
  readonly handlers: readonly GuobaApiHandler[];
}

const methods = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"];
const parameter = /^:([A-Za-z_][A-Za-z0-9_]*)$/u;
const requestHeaderNames = ["content-type", "host", "origin", "sec-fetch-site"] as const;

function extensionRequestHeaders(request: Request): GuobaApiRequest["headers"] {
  const headers: Record<string, string> = Object.create(null);
  for (const name of requestHeaderNames) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return Object.freeze(headers);
}

function pathSegments(path: string): string[] {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error();
  const relative = path.slice(1).replace(/\/$/u, "");
  const segments = relative ? relative.split("/") : [];
  if (segments.some((part) => part === "" || part === "." || part === ".." || /[\\\u0000-\u001f\u007f]/u.test(part))) {
    throw new Error();
  }
  return segments;
}

export function validGuobaApiRoute(route: string): boolean {
  try {
    const parameters = new Set<string>();
    return pathSegments(route).every((part) => {
      const name = parameter.exec(part)?.[1];
      if (name) {
        if (parameters.has(name)) return false;
        parameters.add(name);
        return true;
      }
      return !/[:?*+#%[\](){}]/u.test(part);
    });
  } catch {
    return false;
  }
}

function decodePath(path: string): string[] {
  return pathSegments(path).map((part) => {
    const value = decodeURIComponent(part);
    if (value === "." || value === ".." || /[/\\\u0000-\u001f\u007f]/u.test(value)) throw new Error();
    return value;
  });
}

function routeParams(route: string, requested: readonly string[]): Record<string, string> | undefined {
  const pattern = pathSegments(route);
  if (pattern.length !== requested.length) return;
  const params: Record<string, string> = Object.create(null);
  for (const [index, value] of requested.entries()) {
    const part = pattern[index]!;
    const name = parameter.exec(part)?.[1];
    if (name) params[name] = value;
    else if (part !== value) return;
  }
  return params;
}

function queryParams(search: URLSearchParams): GuobaApiRequest["query"] {
  const query: GuobaApiRequest["query"] = Object.create(null);
  for (const [key, value] of search) {
    const previous = query[key];
    if (Array.isArray(previous)) previous.push(value);
    else query[key] = previous === undefined ? value : [previous, value];
  }
  return query;
}

function apiError(status: number, error: string, method: string, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  if (method === "HEAD") {
    headers.set("Content-Type", "application/json");
    return new Response(null, { status, headers });
  }
  return Response.json({ ok: false, error }, { status, headers });
}

async function runHandlers(
  request: GuobaApiRequest,
  handlers: readonly GuobaApiHandler[],
): Promise<Response | undefined> {
  let status = 200;
  let reply: Response | undefined;
  let skipped = false;
  let failed = false;
  const headers = new Headers();

  function send(value: unknown, json: boolean): GuobaApiResponse {
    if (reply || failed || skipped) return response;
    if (value === undefined || [204, 205, 304].includes(status)) {
      reply = new Response(null, { status, headers });
    } else if (json) {
      headers.set("Content-Type", "application/json");
      reply = request.method === "HEAD" ? new Response(null, { status, headers }) : Response.json(value, { status, headers });
    } else {
      headers.set("Content-Type", "text/plain; charset=utf-8");
      reply = new Response(request.method === "HEAD" ? null : String(value), { status, headers });
    }
    return response;
  }

  const response: GuobaApiResponse = {
    get headersSent() {
      return reply !== undefined;
    },
    setHeader(name, value) {
      // The host owns API policy headers. Providers can request the same non-cacheable policy.
      if (!reply && !failed && !skipped && typeof name === "string" && name.toLowerCase() === "cache-control" &&
          typeof value === "string" && value.trim().toLowerCase() === "no-store") headers.set("Cache-Control", "no-store");
      return response;
    },
    status(code) {
      if (!Number.isInteger(code) || code < 200 || code > 599) throw new Error();
      if (!reply) status = code;
      return response;
    },
    json(data) {
      return send(data, true);
    },
    send(data) {
      return send(data, typeof data !== "string");
    },
    end() {
      return send(undefined, false);
    },
  };

  async function invoke(index: number): Promise<void> {
    const handler = handlers[index];
    if (!handler) {
      skipped = true;
      return;
    }
    let open = true;
    let continuation: Promise<void> | undefined;
    try {
      await handler(request, response, (error) => {
        if (!open || continuation || reply || failed || skipped) return;
        if (error === "route") skipped = true;
        else if (error !== undefined && error !== null) failed = true;
        else continuation = invoke(index + 1);
      });
    } catch {
      failed = true;
    } finally {
      open = false;
    }
    await continuation;
  }

  await invoke(0);
  if (reply) {
    const completed = reply as Response;
    return completed.status >= 500
      ? apiError(completed.status, "扩展接口处理失败。", request.method)
      : completed;
  }
  if (skipped && !failed) return;
  return apiError(500, "扩展接口处理失败。", request.method);
}

export async function dispatchGuobaApi(
  request: Request,
  pathname: string,
  routes: readonly GuobaApiDefinition[],
): Promise<Response> {
  const method = request.method;
  let requested: string[];
  try {
    requested = decodePath(pathname);
  } catch {
    return apiError(400, "扩展接口路径无效。", method);
  }

  const matches = [];
  const allowed = new Set<string>();
  for (const definition of routes) {
    if (!validGuobaApiRoute(definition.route)) continue;
    const params = routeParams(definition.route, requested);
    if (!params) continue;
    const registered = definition.method.toUpperCase();
    if (registered === "ALL") methods.forEach((entry) => allowed.add(entry));
    else if (methods.includes(registered)) {
      allowed.add(registered);
      if (registered === "GET") allowed.add("HEAD");
    }
    if (methods.includes(method) &&
        (registered === method || registered === "ALL" || (method === "HEAD" && registered === "GET"))) {
      matches.push({ definition, params });
    }
  }
  if (!matches.length && allowed.size) {
    return apiError(405, "扩展接口不支持此请求方法。", method, {
      Allow: methods.filter((entry) => allowed.has(entry)).join(", "),
    });
  }

  if (matches.length) {
    let body: unknown;
    if (request.body) {
      try {
        body = await readPanelJson(request);
      } catch {
        return apiError(400, "扩展接口请求须为有效且不超过 64 KiB 的 JSON。", method);
      }
    }
    const query = queryParams(new URL(request.url).searchParams);
    const headers = extensionRequestHeaders(request);
    for (const { definition, params } of matches) {
      const response = await runHandlers({
        method, path: pathname, query, params, body, headers,
        get: name => typeof name === "string" ? headers[name.toLowerCase()] : undefined,
      }, definition.handlers);
      if (response) return response;
    }
  }
  return apiError(404, "扩展接口不存在。", method);
}
