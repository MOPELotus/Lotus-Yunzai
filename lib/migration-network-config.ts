import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createSecureContext } from "node:tls";
import { readMigrationSourceFile } from "./migration-files.ts";
import { parseMilkySettings } from "./adapters/milky-config.ts";
import { parseServerSettings, type ServerEnvironment } from "./server.ts";
import { parseStorageSettings } from "./valkey-config.ts";
import { withinInstallation } from "./plugins/migration-plan.ts";

type Fields = Readonly<Record<string, unknown>>;
type NetworkConfig = Partial<Record<"server" | "milky" | "redis", Fields>>;
type Deferred = "server.https.files" | "server.https.port-collision" | "server.https.invalid" |
  "server.https.unsafe-files" | "server.https.invalid-key-pair" |
  "server.onebot.authorization" | "milky.remote" | "milky.webhook.authorization" | "redis.remote";
type Note = "server.listeners.shared" | "server.listeners.separate" | "server.listeners.all-interfaces-default" |
  "server.authorization.headers-only" | "milky.ws.authorization-header" |
  "redis.existing-service";

interface NetworkMigrationPolicy {
  readonly remoteMilky?: boolean;
  readonly remoteRedis?: boolean;
  readonly serverEnvironment?: ServerEnvironment;
}

function pick(source: Fields, keys: readonly string[]) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
}

function subsection(source: unknown, path: string): Fields | undefined {
  if (source === undefined || source === null) return;
  if (typeof source !== "object" || Array.isArray(source)) throw new Error($t("lib.migration-network-config.text_1f93cea4a9", { "path": path }));
  return source as Fields;
}

function loopback(hostname: string) {
  return hostname.toLowerCase() === "localhost" || hostname === "::1" || hostname === "[::1]" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."));
}

function projectMilky(source: Fields) {
  const projected = pick(source, ["enable", "host", "port", "prefix", "access_token", "connection", "http_timeout"]);
  for (const [key, fields] of [
    ["webhook", ["path"]], ["ws", ["heartbeat", "reconnect_interval"]],
  ] as const) {
    const section = subsection(source[key], "milky." + key);
    if (section) projected[key] = pick(section, fields);
  }
  // The old adapter treated an explicitly set SSL flag as truthy.
  for (const key of ["ssl", "use_ssl"]) {
    if (Object.hasOwn(source, key)) projected[key] = Boolean(source[key]);
  }
  const host = source.host ?? "127.0.0.1";
  if (typeof host === "string" && !/^https?:\/\//iu.test(host.trim())) {
    const native = parseMilkySettings(projected);
    const legacyTls = source.port === 443 || Boolean(source.ssl) || Boolean(source.use_ssl);
    // TRSS used the configured port for TLS selection even when a different port was embedded in the host.
    if (native && (native.apiBase.protocol === "https:") !== legacyTls) {
      projected.host = (legacyTls ? "https://" : "http://") + host.trim();
    }
  }
  return projected;
}

/** Values are private staging input. Only deferred identifiers and notes belong in a migration report. */
export function projectLegacyNetworkConfig(source: NetworkConfig, policy: NetworkMigrationPolicy = {}) {
  const config: NetworkConfig = {};
  const notes: Note[] = [];
  const deferred: Deferred[] = [];
  const env = policy.serverEnvironment ?? {};
  let server = parseServerSettings({}, env);

  if (source.server) {
    const projected = pick(source.server, ["url", "port", "auth", "redirect", "onebot_token", "onebot_port", "onebot_enable", "panel_url", "web_mount", "captcha"]);
    server = parseServerSettings(projected, env);
    if (server.http && server.oneBot) {
      notes.push(server.http.port === server.oneBot.port ? "server.listeners.shared" : "server.listeners.separate");
    } else if (server.http && !server.oneBot && projected.onebot_enable !== false) {
      deferred.push("server.onebot.authorization");
    }
    if ((server.http || server.oneBot) && env.LOTUS_LISTEN_HOST === undefined) notes.push("server.listeners.all-interfaces-default");
    if (server.http?.auth.keys().next().value || server.oneBot?.auth.keys().next().value) {
      notes.push("server.authorization.headers-only");
    }
    const tls = source.server.https;
    if (tls === null || tls === false) projected.https = tls;
    else if (tls !== undefined) {
      const https = parseServerSettings({ ...projected, https: tls }, env);
      if (https.httpsError) deferred.push("server.https.invalid");
      if (https.https) {
        const port = https.https.port;
        if (port !== 0 && (port === server.http?.port || port === server.oneBot?.port)) {
          deferred.push("server.https.port-collision");
        }
        deferred.push("server.https.files");
      }
    }
    config.server = projected;
  }

  if (source.milky) {
    const projected = projectMilky(source.milky);
    const milky = parseMilkySettings(projected);
    if (milky && !loopback(milky.apiBase.hostname) && !policy.remoteMilky) {
      deferred.push("milky.remote");
    } else if (milky?.connection === "webhook" && !milky.accessToken && !server.http?.auth.keys().next().value) {
      deferred.push("milky.webhook.authorization");
    } else {
      config.milky = projected;
      if (milky?.connection === "ws" && milky.accessToken) notes.push("milky.ws.authorization-header");
    }
  }

  if (source.redis) {
    const projected = pick(source.redis, ["host", "port", "username", "password", "db"]);
    const storage = parseStorageSettings(projected);
    if (source.redis.path) notes.push("redis.existing-service");
    if (!loopback(storage.host) && !policy.remoteRedis) deferred.push("redis.remote");
    else config.redis = projected;
  }

  return { config, deferred, notes };
}

const families = ["server", "milky", "redis"] as const;
type Family = (typeof families)[number];
const httpsFiles = {
  key: "config/tls/legacy-server-key.pem",
  cert: "config/tls/legacy-server-cert.pem",
} as const;

async function readFamilyFile(source: string, prefix: string, family: Family, signal?: AbortSignal): Promise<Fields | undefined> {
  let file;
  try {
    file = await readMigrationSourceFile(source, join(source, prefix, `${family}.yaml`), 256 * 1024, signal);
  } catch {
    signal?.throwIfAborted();
    throw new Error($t("lib.migration-network-config.text_c73de64a6c", { "family": family }));
  }
  if (!file) return;
  try {
    const config: unknown = Bun.YAML.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    return subsection(config, family) ?? {};
  } catch {
    throw new Error($t("lib.migration-network-config.text_b5e81f69d3", { "family": family }));
  }
}

async function readFamily(source: string, family: Family, signal?: AbortSignal): Promise<Fields | undefined> {
  const active = await readFamilyFile(source, "config", family, signal);
  if (active !== undefined) return active;
  const [defaults, runtime] = await Promise.all([
    readFamilyFile(source, "config/default_config", family, signal),
    readFamilyFile(source, "config/config", family, signal),
  ]);
  if (defaults !== undefined || runtime !== undefined) return { ...defaults, ...runtime };
}

async function readTlsPair(source: string, keyPath: string, certPath: string, signal?: AbortSignal) {
  try {
    const [key, cert] = await Promise.all([
      readMigrationSourceFile(source, resolve(source, keyPath), 1024 * 1024, signal),
      readMigrationSourceFile(source, resolve(source, certPath), 1024 * 1024, signal),
    ]);
    if (key && cert && (key.dev !== cert.dev || key.ino !== cert.ino)) return { key: key.bytes, cert: cert.bytes };
  } catch {
    signal?.throwIfAborted();
  }
}

function validTlsPair(pair: { key: Buffer; cert: Buffer }) {
  try {
    const key = createPublicKey(createPrivateKey(pair.key)).export({ type: "spki", format: "der" });
    const cert = new X509Certificate(pair.cert).publicKey.export({ type: "spki", format: "der" });
    if (!key.equals(cert)) return false;
    createSecureContext(pair);
    return true;
  } catch {
    return false;
  }
}

async function privateDirectory(root: string, path: string) {
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!info) await mkdir(current, { mode: 0o700 });
    if (!(await lstat(current)).isDirectory() || await realpath(current) !== current) {
      throw new Error($t("lib.migration-network-config.text_57a04dc201"));
    }
  }
}

/** Stages configuration only. Endpoints are never contacted and secrets are never included in the report. */
export async function stageLegacyNetworkConfig(sourcePath: string, stagePath: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const [source, stage] = await Promise.all([realpath(sourcePath), realpath(stagePath)]);
  const [sourceInfo, stageInfo] = await Promise.all([lstat(source), lstat(stage)]);
  if (!sourceInfo.isDirectory() || !stageInfo.isDirectory() || withinInstallation(source, stage) ||
      withinInstallation(stage, source) || (sourceInfo.dev === stageInfo.dev && sourceInfo.ino === stageInfo.ino)) {
    throw new Error($t("lib.migration-network-config.text_bca686ceec"));
  }
  const raw: NetworkConfig = {};
  for (const family of families) {
    const config = await readFamily(source, family, signal);
    if (config) raw[family] = config;
  }

  const projected = projectLegacyNetworkConfig(raw, { remoteMilky: true, remoteRedis: true });
  const deferred = projected.deferred.filter(item => item !== "server.https.files");
  const outputs = new Map<string, string | Buffer>();
  if (deferred.includes("server.onebot.authorization")) {
    projected.config.server = { ...projected.config.server, onebot_token: null };
  }
  if (projected.deferred.includes("server.https.files") && !deferred.includes("server.https.port-collision")) {
    const https = parseServerSettings({ https: raw.server?.https }, {}).https;
    if (https) {
      const pair = await readTlsPair(source, https.key, https.cert, signal);
      if (!pair) deferred.push("server.https.unsafe-files");
      else if (!validTlsPair(pair)) deferred.push("server.https.invalid-key-pair");
      else {
        outputs.set(httpsFiles.key, pair.key);
        outputs.set(httpsFiles.cert, pair.cert);
        projected.config.server = { ...projected.config.server,
          https: { ...httpsFiles, port: https.port, ...(https.publicUrl && { url: https.publicUrl.href }) } };
      }
    }
  }
  const groups = families.filter(family => projected.config[family] !== undefined);
  for (const family of groups) {
    outputs.set(`config/${family}.yaml`, Bun.YAML.stringify(projected.config[family]));
  }
  signal?.throwIfAborted();
  const written: string[] = [];
  try {
    for (const [path, value] of outputs) {
      signal?.throwIfAborted();
      const file = join(stage, path);
      await privateDirectory(stage, dirname(file));
      const handle = await open(file, "wx", 0o600);
      written.push(file);
      try {
        await handle.writeFile(value);
      } finally {
        await handle.close();
      }
    }
    signal?.throwIfAborted();
    return { groups, deferred };
  } catch (error) {
    await Promise.all(written.map(file => rm(file)));
    throw error;
  }
}
