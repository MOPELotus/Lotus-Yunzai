import { isAbsolute } from "node:path";
import { readLocalConfig } from "./config.ts";
import { isReservedServerPath, readServerRedirect } from "./server-redirect.ts";

type ServerEnvironment = Readonly<Record<string, string | undefined>>;

interface Listener {
  readonly port: number;
  readonly auth: Headers;
}

interface HttpsListener extends Listener {
  readonly key: string;
  readonly cert: string;
  readonly publicUrl?: URL;
  readonly oneBotAuth?: Headers;
}

export interface ServerSettings {
  readonly hostname: string;
  readonly http?: Listener;
  readonly oneBot?: Listener;
  readonly https?: HttpsListener;
  readonly httpsError?: boolean;
  readonly panelToken?: string;
  readonly publicUrl?: URL;
  readonly manualCaptchaUrl?: string;
  readonly redirect?: string;
  readonly webMount?: WebMountSettings;
}

export interface WebMountSettings {
  readonly directory: string;
  readonly socket: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function webMountSettings(value: unknown): WebMountSettings | undefined {
  if (value === undefined || value === null || value === false) return;
  const { directory, socket } = record(value) ? value : {};
  if (typeof directory !== "string" || typeof socket !== "string" ||
      !isAbsolute(directory) || !isAbsolute(socket) || /[\u0000-\u001f]/u.test(directory + socket)) {
    throw new Error("config/server.yaml 的 web_mount.directory 和 web_mount.socket 须为绝对路径。");
  }
  return { directory, socket };
}

function port(value: unknown, source: string): number | undefined {
  if (value === undefined) return;
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 0 || number > 65535) {
    throw new Error(`${source} 须为 0–65535 的端口号。`);
  }
  return number;
}

function publicHttpUrl(value: unknown): URL | undefined {
  if (value === null || value === undefined) return;
  const source = typeof value === "string" ? value.trim() : "";
  if (typeof value === "string" && !source) return;
  const url = /^https?:\/\/[^/@]+(?:\/.*)?$/iu.test(source) && !/[\s\\?#\0]/u.test(source)
    ? URL.parse(source) : null;
  if (!url || url.username || url.password) {
    throw new Error("config/server.yaml 的 url 须为不含认证信息、查询参数或片段的 HTTP(S) 绝对地址。");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
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

function tlsPath(value: unknown): string | undefined {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || value.includes("\0")) throw new Error();
  return value || undefined;
}

function httpsSettings(value: unknown, auth: Headers, oneBotAuth?: Headers): Pick<ServerSettings, "https" | "httpsError"> {
  if (value === undefined || value === null || value === false) return {};
  if (!record(value)) return { httpsError: true };
  try {
    const key = tlsPath(value.key);
    const cert = tlsPath(value.cert);
    const configuredPort = port(value.port ?? undefined, "server.https.port");
    const publicUrl = publicHttpUrl(value.url);
    if (!key && !cert && configuredPort === undefined && !publicUrl) return {};
    if (!key || !cert) return { httpsError: true };
    return {
      https: {
        port: configuredPort ?? 0, key, cert, publicUrl, auth: new Headers(auth),
        oneBotAuth: oneBotAuth && new Headers(oneBotAuth),
      },
    };
  } catch {
    return { httpsError: true };
  }
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
  const captcha = config.captcha;
  const manualCaptchaUrl = env.LOTUS_CAPTCHA_PUBLIC_URL ?? (record(captcha) && typeof captcha.url === "string" ? captcha.url : undefined);
  const wsPort = [...wsAuth.keys()].length > 0 ? oneBotOverride ?? configured ?? 25360 : undefined;
  const httpPort = configured ?? wsPort ??
    (env.LOTUS_HTTP_TOKEN !== undefined || panelToken !== undefined ? 2536 : undefined);

  return {
    hostname: env.LOTUS_LISTEN_HOST ?? "127.0.0.1",
    http: httpPort === undefined ? undefined : { port: httpPort, auth: httpAuth },
    oneBot: wsPort === undefined ? undefined : { port: wsPort, auth: wsAuth },
    panelToken,
    publicUrl: publicHttpUrl(config.url),
    manualCaptchaUrl: manualCaptchaUrl?.trim() || undefined,
    redirect: readServerRedirect(config.redirect),
    webMount: webMountSettings(config.web_mount),
    ...httpsSettings(config.https, httpAuth, wsPort === undefined ? undefined : wsAuth),
  };
}

export function authorized(request: Request, required: Headers): boolean {
  for (const [key, value] of required) {
    if (request.headers.get(key) !== value) return false;
  }
  return true;
}

export function publicPostPath(path: string): string | undefined {
  if (!/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/u.test(path) ||
      /(?:^|\/)\.{1,2}(?:\/|$)/u.test(path) || isReservedServerPath(path)) return;
  return path.replace(/\/$/u, "").toLowerCase();
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
