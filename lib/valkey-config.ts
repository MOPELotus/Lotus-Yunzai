import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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
  throw new Error($t("lib.valkey-config.text_8eb2e06c1a"));
}

function readInteger(value: unknown, key: "port" | "db", fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const number = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value) : value;
  if (typeof number === "number" && Number.isSafeInteger(number) && number >= min && number <= max) return number;
  throw new Error($t("lib.valkey-config.text_889ba748d6", { "key": key }));
}

function readCredential(value: unknown, key: "username" | "password"): string | undefined {
  if (value === undefined || value === null || value === "") return;
  if (typeof value === "string") return value;
  throw new Error($t("lib.valkey-config.text_01b067eb79", { "key": key }));
}

export async function readStorageConnection(
  root: URL, url?: string,
): Promise<string | StorageConnectionOptions | undefined> {
  if (url !== undefined) return url;
  const config = await readOptionalLocalConfig(root, "redis");
  if (!config) return (await import("./managed-valkey.ts")).managedValkeyConnection(root);
  if (config.enable === false) return;
  return parseStorageSettings(config);
}

export function parseStorageSettings(config: Readonly<Record<string, unknown>>): StorageConnectionOptions {
  if (config.socket !== undefined && (typeof config.socket !== "string" || !config.socket.startsWith("/") || /[\0\r\n]/u.test(config.socket))) throw new Error($t("lib.valkey-config.text_9a77abc459"));
  return {
    host: readHost(config.host),
    port: readInteger(config.port, "port", 6379, typeof config.socket === "string" ? 0 : 1, 65535),
    database: readInteger(config.db, "db", 0, 0, Number.MAX_SAFE_INTEGER),
    username: readCredential(config.username, "username"),
    password: readCredential(config.password, "password"),
    ...(typeof config.socket === "string" && config.socket.startsWith("/") ? { socketPath: config.socket } : {}),
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
      port: readInteger(value.port, "port", 6379, "socketPath" in value && typeof value.socketPath === "string" && value.socketPath.startsWith("/") ? 0 : 1, 65535),
      database: readInteger(value.database, "db", 0, 0, Number.MAX_SAFE_INTEGER),
      username: readCredential("username" in value ? value.username : undefined, "username"),
      password: readCredential("password" in value ? value.password : undefined, "password"),
      ...("socketPath" in value && typeof value.socketPath === "string" && value.socketPath.startsWith("/") ? { socketPath: value.socketPath } : {}),
    };
  } catch { return; }
}

export function storageRevision(snapshot: StorageSnapshot) {
  const canonical = snapshot !== null && typeof snapshot === "object" ? {
    host: snapshot.host, port: snapshot.port, database: snapshot.database,
    username: snapshot.username, password: snapshot.password, socketPath: snapshot.socketPath,
  } : snapshot;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
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
