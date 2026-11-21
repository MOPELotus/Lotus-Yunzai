import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { devNull } from "node:os";
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

export type StorageSnapshot = string | StorageConnectionOptions | null;

export function parseStorageSnapshot(value: unknown): StorageSnapshot | undefined {
  if (value === null) return null;
  if (typeof value === "string") {
    const protocol = URL.parse(value)?.protocol;
    if (protocol === "redis:" || protocol === "rediss:") return value;
    return;
  }
  if (!value || typeof value !== "object" || !("host" in value) || typeof value.host !== "string" ||
      !("port" in value) || !("database" in value)) return;
  try {
    return {
      host: readHost(value.host),
      port: readInteger(value.port, "port", 6379, 1, 65535),
      database: readInteger(value.database, "db", 0, 0, Number.MAX_SAFE_INTEGER),
      username: readCredential("username" in value ? value.username : undefined, "username"),
      password: readCredential("password" in value ? value.password : undefined, "password"),
    };
  } catch { return; }
}

export function storageRevision(snapshot: StorageSnapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export async function readStorageRevision(root: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const command = `import { readStorageConnection, storageRevision } from ${JSON.stringify(import.meta.url)};
const settings = await readStorageConnection(Bun.pathToFileURL(process.cwd() + "/"), Bun.env.LOTUS_VALKEY_URL);
console.log(storageRevision(settings ?? null));`;
  const { BUN_OPTIONS: _preload, ...workerEnv } = env;
  const child = Bun.spawn([process.execPath, "--config=" + devNull, "--no-install", "-e", command], {
    cwd: root, env: workerEnv, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]), killSignal: "SIGKILL", maxBuffer: 256,
  });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  signal.throwIfAborted();
  const revision = output.trim();
  return code === 0 && /^[a-f0-9]{64}$/u.test(revision) ? revision : undefined;
}
