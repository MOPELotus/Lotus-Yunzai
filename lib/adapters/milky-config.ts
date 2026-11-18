import { isIP } from "node:net";
import { readLocalConfig } from "../config.ts";
import { publicPostPath } from "../server.ts";

export interface MilkySettings {
  readonly apiBase: URL;
  readonly eventUrl: URL;
  readonly connection: "webhook" | "ws";
  readonly webhookPath: string;
  readonly accessToken?: string;
  readonly timeoutMs: number;
  readonly reconnectMs: number;
  readonly heartbeatMs: number;
}

function invalid(field: string): never {
  throw new Error(`config/milky.yaml 的 ${field} 无效。`);
}

function section(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return invalid(field);
  return value as Record<string, unknown>;
}

function portNumber(value: unknown): number {
  const source = value ?? 3000;
  const port = typeof source === "string" && /^\d+$/u.test(source) ? Number(source) : source;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return invalid("port");
  return port;
}

function milliseconds(value: unknown, fallback: number, field: string): number {
  const source = value ?? fallback;
  const seconds = typeof source === "string" && /^\d+(?:\.\d+)?$/u.test(source) ? Number(source) : source;
  if (typeof seconds !== "number") return invalid(field);
  const ms = Math.ceil((seconds === 0 ? fallback : seconds) * 1000);
  if (!Number.isInteger(ms) || ms < 1 || ms > 2_147_483_647) return invalid(field);
  return ms;
}

function destination(config: Record<string, unknown>): URL {
  const host = config.host ?? "127.0.0.1";
  if (typeof host !== "string") return invalid("host");
  const authority = /^(?:(https?):\/\/)?([^/?#\\@%\s\u0000-\u001f\u007f]+)$/iu.exec(host.trim());
  if (!authority) return invalid("host");
  const source = authority[2]!;
  const literal = isIP(source) === 6 ? `[${source}]` : source;
  const address = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d+))?$/u.exec(literal);
  if (!address) return invalid("host");
  const port = portNumber(address[2] ?? config.port);
  const scheme = authority[1]?.toLowerCase() ??
    (port === 443 || config.ssl === true || config.use_ssl === true ? "https" : "http");
  const url = URL.parse(`${scheme}://${address[1]}:${port}/`);
  if (!url || url.hostname === "0.0.0.0" || url.hostname === "[::]") return invalid("host");
  return url;
}

function pathPrefix(value: unknown): string {
  if (value === undefined || value === null || value === "" || value === "/") return "";
  if (typeof value !== "string" || !/^\/[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*\/?$/u.test(value) ||
      /\/\.{1,2}(?:\/|$)/u.test(value)) return invalid("prefix");
  return value.replace(/\/$/u, "");
}

function token(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string" || !/^[!-~]+$/u.test(value)) return invalid("access_token");
  return value;
}

export async function readMilkySettings(root: URL): Promise<MilkySettings | undefined> {
  const config = await readLocalConfig(root, "milky");
  if (config.enable === undefined || config.enable === null || config.enable === false || config.enable === 0) return;
  if (config.enable !== true && config.enable !== 1) return invalid("enable");

  const url = destination(config);
  const prefix = pathPrefix(config.prefix);
  const apiBase = new URL(`${prefix}/api/`, url);
  const eventUrl = new URL(`${prefix}/event`, url);
  eventUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const connection = config.connection ?? "ws";
  if (connection !== "ws" && connection !== "webhook") return invalid("connection");
  const webhook = section(config.webhook, "webhook");
  const ws = section(config.ws, "ws");
  const webhookSource = webhook.path ?? "/milky";
  const webhookPath = typeof webhookSource === "string" ? publicPostPath(webhookSource) : undefined;
  if (!webhookPath) return invalid("webhook.path");

  return {
    apiBase, eventUrl, connection, webhookPath, accessToken: token(config.access_token),
    timeoutMs: milliseconds(config.http_timeout, 15, "http_timeout"),
    reconnectMs: milliseconds(ws.reconnect_interval, 10, "ws.reconnect_interval"),
    heartbeatMs: milliseconds(ws.heartbeat, 30, "ws.heartbeat"),
  };
}
