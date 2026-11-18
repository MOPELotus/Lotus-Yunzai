import { readLocalConfig } from "./config.ts";

type ServerEnvironment = Readonly<Record<string, string | undefined>>;

interface Listener {
  readonly port: number;
  readonly auth: Headers;
}

export interface ServerSettings {
  readonly hostname: string;
  readonly http?: Listener;
  readonly oneBot?: Listener;
  readonly panelToken?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function port(value: unknown, source: string): number | undefined {
  if (value === undefined) return;
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 0 || number > 65535) {
    throw new Error(`${source} 须为 0–65535 的端口号。`);
  }
  return number;
}

function authHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (value === undefined || value === null) return headers;
  if (!record(value)) throw new Error("config/server.yaml 的 auth 须为请求头映射。");
  try {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "string" || !item.trim()) throw new Error();
      headers.set(key, item);
    }
  } catch {
    throw new Error("config/server.yaml 的 auth 请求头无效。");
  }
  return headers;
}

function withToken(base: Headers, token: string | undefined, source: string): Headers {
  const headers = new Headers(base);
  if (token !== undefined) {
    if (!token.trim() || /[\s\0]/u.test(token)) throw new Error(`${source} 的令牌格式无效。`);
    try {
      headers.set("Authorization", `Bearer ${token}`);
    } catch {
      throw new Error(`${source} 的令牌格式无效。`);
    }
  }
  return headers;
}

export async function readServerSettings(root: URL, env: ServerEnvironment): Promise<ServerSettings> {
  const config = await readLocalConfig(root, "server");
  const configured = port(env.LOTUS_HTTP_PORT ?? config.port, "LOTUS_HTTP_PORT 或 server.port");
  const oneBotOverride = port(env.LOTUS_ONEBOT_PORT, "LOTUS_ONEBOT_PORT");
  const legacyAuth = authHeaders(config.auth);
  const httpAuth = withToken(legacyAuth, env.LOTUS_HTTP_TOKEN, "LOTUS_HTTP_TOKEN");
  const wsAuth = withToken(legacyAuth, env.LOTUS_ONEBOT_TOKEN, "LOTUS_ONEBOT_TOKEN");
  const panelToken = env.LOTUS_PANEL_TOKEN;
  withToken(new Headers(), panelToken, "LOTUS_PANEL_TOKEN");
  const wsPort = [...wsAuth.keys()].length > 0 ? oneBotOverride ?? configured ?? 25360 : undefined;
  const httpPort = configured ?? wsPort ??
    (env.LOTUS_HTTP_TOKEN !== undefined || panelToken !== undefined ? 2536 : undefined);

  return {
    hostname: env.LOTUS_LISTEN_HOST ?? "127.0.0.1",
    http: httpPort === undefined ? undefined : { port: httpPort, auth: httpAuth },
    oneBot: wsPort === undefined ? undefined : { port: wsPort, auth: wsAuth },
    panelToken,
  };
}

export function authorized(request: Request, required: Headers): boolean {
  for (const [key, value] of required) {
    if (request.headers.get(key) !== value) return false;
  }
  return true;
}

export interface StatusVersion {
  readonly version?: string;
  readonly revision?: string;
  readonly modified?: boolean;
}

export function httpStatus(required: Headers, version?: StatusVersion) {
  return (request: Request): Response => {
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/status" && pathname !== "/status/") return new Response(null, { status: 404 });
    if (!authorized(request, required)) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const response = Response.json(runtimeStatus(version), { headers: { "Cache-Control": "no-store" } });
    return request.method === "HEAD" ? new Response(null, { headers: response.headers }) : response;
  };
}

export function runtimeStatus({ version, revision, modified }: StatusVersion = {}) {
  return {
    status: "ok", name: "Lotus-Yunzai", bun: Bun.version, uptime: Math.floor(process.uptime()),
    ...(version === undefined ? {} : { version }),
    ...(revision === undefined ? {} : { revision }),
    ...(modified === undefined ? {} : { modified }),
  };
}
