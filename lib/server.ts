import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { isInternalAddress } from "./network-access.ts";
import { isAbsolute } from "node:path";
import { readLocalConfig } from "./config.ts";
import { isReservedServerPath, readServerRedirect } from "./server-redirect.ts";

export type ServerEnvironment = Readonly<Record<string, string | undefined>>;

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
  readonly panelPublicUrl?: URL;
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
    throw new Error($t("lib.server.text_ece3e76647"));
  }
  return { directory, socket };
}

function port(value: unknown, source: string): number | undefined {
  if (value === undefined) return;
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 0 || number > 65535) {
    throw new Error($t("lib.server.text_dc3165726e", { "source": source }));
  }
  return number;
}

function publicHttpUrl(value: unknown, sourceName = $t("lib.server.text_2cabdb5bc2")): URL | undefined {
  if (value === null || value === undefined) return;
  const source = typeof value === "string" ? value.trim() : "";
  if (typeof value === "string" && !source) return;
  const url = /^https?:\/\/[^/@]+(?:\/.*)?$/iu.test(source) && !/[\s\\?#\0]/u.test(source)
    ? URL.parse(source) : null;
  if (!url || url.username || url.password) {
    throw new Error($t("lib.server.text_e485b0b865", { "sourceName": sourceName }));
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
}

export function panelPublicPage(base: URL | undefined) {
  if (!base || base.username || base.password || base.search || base.hash ||
    !base.pathname.endsWith("/") || base.pathname.startsWith("//") || base.pathname.includes(";")) return;
  if (base.protocol !== "https:" && (base.protocol !== "http:" ||
    !(base.hostname === "localhost" || isInternalAddress(base.hostname.replace(/^\[|\]$/gu, ""))))) return;
  return new URL("panel/", base);
}

function authHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (value === undefined || value === null) return headers;
  if (!record(value)) throw new Error($t("lib.server.text_9b88612044"));
  try {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "string" || !item.trim()) throw new Error();
      headers.set(key, item);
    }
  } catch {
    throw new Error($t("lib.server.text_805b191330"));
  }
  return headers;
}

function withToken(base: Headers, token: string | undefined, source: string): Headers {
  const headers = new Headers(base);
  if (token !== undefined) {
    if (!token.trim() || /[\s\0]/u.test(token)) throw new Error($t("lib.server.text_d64598da26", { "source": source }));
    try {
      headers.set("Authorization", `Bearer ${token}`);
    } catch {
      throw new Error($t("lib.server.text_d64598da26", { "source": source }));
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

export async function readServerWebMount(root: URL): Promise<WebMountSettings | undefined> {
  const config = await readLocalConfig(root, "server");
  return webMountSettings(config.web_mount);
}

export async function readServerHttpsPaths(root: URL): Promise<Pick<HttpsListener, "key" | "cert"> | undefined> {
  const config = await readLocalConfig(root, "server");
  return httpsSettings(config.https, new Headers()).https;
}

export async function readServerSettings(root: URL, env: ServerEnvironment): Promise<ServerSettings> {
  return parseServerSettings(await readLocalConfig(root, "server"), env);
}

export function parseServerSettings(config: Readonly<Record<string, unknown>>, env: ServerEnvironment): ServerSettings {
  const configured = port(env.LOTUS_HTTP_PORT ?? config.port, $t("lib.server.text_beff505ae5"));
  const oneBotOverride = port(env.LOTUS_ONEBOT_PORT ?? config.onebot_port, env.LOTUS_ONEBOT_PORT === undefined ? "onebot_port" : "LOTUS_ONEBOT_PORT");
  const legacyAuth = authHeaders(config.auth);
  const httpAuth = withToken(legacyAuth, env.LOTUS_HTTP_TOKEN, "LOTUS_HTTP_TOKEN");
  const oneBotToken = config.onebot_token;
  if (oneBotToken !== undefined && oneBotToken !== null && typeof oneBotToken !== "string") {
    throw new Error($t("lib.server.text_81d10852a1"));
  }
  const wsAuth = withToken(legacyAuth, env.LOTUS_ONEBOT_TOKEN ?? oneBotToken ?? undefined,
    env.LOTUS_ONEBOT_TOKEN === undefined ? $t("lib.server.text_05cd4dcddf") : "LOTUS_ONEBOT_TOKEN");
  const panelToken = env.LOTUS_PANEL_TOKEN;
  withToken(new Headers(), panelToken, "LOTUS_PANEL_TOKEN");
  const panelPublicUrl = publicHttpUrl(env.LOTUS_PANEL_PUBLIC_URL ?? config.panel_url, $t("lib.server.text_a1dd9f703a"));
  if (panelPublicUrl && !panelPublicPage(panelPublicUrl)) {
    throw new Error($t("lib.server.text_9b9ee807ea"));
  }
  const captcha = config.captcha;
  const manualCaptchaUrl = env.LOTUS_CAPTCHA_PUBLIC_URL ?? (record(captcha) && typeof captcha.url === "string" ? captcha.url : undefined);
  if (config.onebot_enable !== undefined && typeof config.onebot_enable !== "boolean") throw new Error($t("lib.server.text_a8c83aaa99"));
  const wsPort = config.onebot_enable === false ? undefined : oneBotOverride ?? configured ?? 2536;
  const httpPort = configured ?? wsPort ??
    (env.LOTUS_HTTP_TOKEN !== undefined || panelToken !== undefined || panelPublicUrl !== undefined ? 2536 : undefined);

  return {
    hostname: env.LOTUS_LISTEN_HOST ?? "0.0.0.0",
    http: httpPort === undefined ? undefined : { port: httpPort, auth: httpAuth },
    oneBot: wsPort === undefined ? undefined : { port: wsPort, auth: wsAuth },
    panelToken,
    panelPublicUrl,
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
