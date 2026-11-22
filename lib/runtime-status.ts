import type { RuntimeStatusAccount, RuntimeStatusSnapshot } from "../plugins/system/index.ts";
import type { RuntimeStatusRedis } from "../plugins/system/status-card-data.ts";
import type { CommandContext } from "./commands.ts";

interface OnlineAccount {
  readonly id: number;
  readonly adapter: RuntimeStatusAccount["adapter"];
  readonly seconds: number;
}

function integer(value: string | undefined) {
  if (!value || !/^\d{1,16}$/u.test(value)) return;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed)) return parsed;
}

export function parseRuntimeStatusRedis(raw: string): RuntimeStatusRedis | undefined {
  if (raw.length > 128 * 1024) return;
  const fields = new Map<string, string>();
  const databases: RuntimeStatusRedis["databases"][number][] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    const db = /^db(\d{1,5})$/u.exec(name);
    if (!db) {
      fields.set(name, value);
      continue;
    }
    const parts = new Map(value.split(",").map(part => {
      const equal = part.indexOf("=");
      return [part.slice(0, equal), part.slice(equal + 1)];
    }));
    const keys = integer(parts.get("keys"));
    const expires = integer(parts.get("expires"));
    const averageTtl = integer(parts.get("avg_ttl"));
    if (keys !== undefined && expires !== undefined && averageTtl !== undefined && databases.length < 16) {
      databases.push({ index: Number(db[1]), keys, expires, averageTtl });
    }
  }
  const release = fields.get("valkey_version") ?? fields.get("redis_version");
  const version = release && /^\d+(?:\.\d+){1,3}(?:-[a-z\d.-]{1,25})?$/iu.test(release) ? release : undefined;
  const usedMemory = integer(fields.get("used_memory"));
  if (!version && usedMemory === undefined) return;
  return {
    version, usedMemory, uptime: integer(fields.get("uptime_in_seconds")),
    peakMemory: integer(fields.get("used_memory_peak")), maxMemory: integer(fields.get("maxmemory")),
    clients: integer(fields.get("connected_clients")), blocked: integer(fields.get("blocked_clients")),
    connections: integer(fields.get("total_connections_received")), commands: integer(fields.get("total_commands_processed")),
    databases,
  };
}

async function readRedisInfo(read: (signal: AbortSignal) => Promise<string>, request?: AbortSignal) {
  const signal = request ? AbortSignal.any([request, AbortSignal.timeout(850)]) : AbortSignal.timeout(850);
  if (signal.aborted) return;
  const { promise, resolve } = Promise.withResolvers<undefined>();
  const stop = () => resolve(undefined);
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await Promise.race([promise, Promise.resolve().then(() => read(signal))]);
  } catch {
    // Keep the status card available when the state store is unavailable.
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export async function readRuntimeStatusRedisClients(read: (signal: AbortSignal) => Promise<string>, signal: AbortSignal) {
  const info = await readRedisInfo(read, signal);
  if (!info || info.length > 16 * 1024) return;
  return integer(/^connected_clients:(\d+)\r?$/mu.exec(info)?.[1]);
}

export function createRuntimeStatus(options: {
  readonly accounts: () => readonly OnlineAccount[];
  readonly readCounts: (kind: "msg" | "image", scope: string, bucket: "total") => Promise<{ send: string; receive: string }>;
  readonly countImages: boolean;
  readonly loadedNames: () => readonly string[] | undefined;
  readonly readRedisStatus?: (signal: AbortSignal) => Promise<string>;
}) {
  return async (context: CommandContext, pro: boolean): Promise<RuntimeStatusSnapshot | undefined> => {
    const { runtimeStatusScope: scope, self_id: id, message_type, privateCredentialSignal } = context;
    if (!scope || context.isDelegated || privateCredentialSignal?.aborted) return;
    const terminal = scope === "terminal" && message_type === "terminal" && context.isMaster;
    const ownerPrivate = message_type === "private" && (scope === "milky" ? context.runtimeDiagnosticsScope === "milky" : context.isMaster);
    if (pro && !terminal && !ownerPrivate) return;

    const online = options.accounts();
    const current = terminal ? online : online.filter(account => account.id === id && account.adapter === scope);
    if (!terminal && !current.length) return;
    const redisStatus = pro && options.readRedisStatus
      ? readRedisInfo(options.readRedisStatus, privateCredentialSignal)
        .then(info => info === undefined ? undefined : parseRuntimeStatusRedis(info)) : undefined;
    const accounts = await Promise.all(current.map(async ({ adapter, seconds, id }): Promise<RuntimeStatusAccount> => {
      const name = adapter === "onebot" ? "OneBot" : "Milky";
      // Existing counters share account IDs across adapters. A dual connection cannot claim an adapter-specific total.
      if (online.some(account => account.id === id && account.adapter !== adapter)) return { name, adapter, seconds };
      const scope = `bot:${id}`;
      const [messages, images] = await Promise.all([
        options.readCounts("msg", scope, "total").catch(() => undefined),
        options.countImages ? options.readCounts("image", scope, "total").catch(() => undefined) : undefined,
      ]);
      return { name, adapter, seconds, ...(messages && { sent: messages.send, received: messages.receive }),
        ...(images && { images: images.send }) };
    }));
    const redis = await redisStatus;
    if (privateCredentialSignal?.aborted || (!terminal && !options.accounts().some(account => account.id === id && account.adapter === scope))) return;
    const loadedNames = pro ? options.loadedNames() : undefined;
    const snapshot = { accounts, ...(redis && { redis }) };
    if (!loadedNames) return snapshot;
    const scriptCount = loadedNames.filter(name => /\.(?:[cm]?[jt]s)$/u.test(name)).length;
    return { ...snapshot, pluginCount: loadedNames.length - scriptCount, scriptCount };
  };
}
