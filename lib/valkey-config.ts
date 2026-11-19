import { isIP } from "node:net";
import type { StorageConnectionOptions } from "@lotus-yunzai/storage";
import { readOptionalLocalConfig } from "./config.ts";

const hostname = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.?$/iu;

function readHost(value: unknown): string {
  if (value === undefined) return "127.0.0.1";
  if (typeof value === "string") {
    const host = value.trim();
    const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (isIP(bare) === 6) return bare;
    if (bare === host && host.length <= 253 && hostname.test(host)) return host;
  }
  throw new Error("redis.yaml 的 host 须为有效的主机名或 IP 地址。");
}

function readInteger(value: unknown, key: "port" | "db", fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const number = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value) : value;
  if (typeof number === "number" && Number.isSafeInteger(number) && number >= min && number <= max) return number;
  throw new Error(`redis.yaml 的 ${key} 不是有效的整数。`);
}

function readCredential(value: unknown, key: "username" | "password"): string | undefined {
  if (value === undefined || value === null || value === "") return;
  if (typeof value === "string") return value;
  throw new Error(`redis.yaml 的 ${key} 须为文本。`);
}

export async function readStorageConnection(
  root: URL, url?: string,
): Promise<string | StorageConnectionOptions | undefined> {
  if (url !== undefined) return url;
  const config = await readOptionalLocalConfig(root, "redis");
  if (!config) return;

  return {
    host: readHost(config.host),
    port: readInteger(config.port, "port", 6379, 1, 65535),
    database: readInteger(config.db, "db", 0, 0, Number.MAX_SAFE_INTEGER),
    username: readCredential(config.username, "username"),
    password: readCredential(config.password, "password"),
  };
}
