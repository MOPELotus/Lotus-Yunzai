import { createClient } from "redis";

export { createRoleJsonArchive, type AcquireRoleArchiveLock } from "./role-json-archive.ts";

export interface StorageConnectionOptions {
  readonly socketPath?: string;
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly database: number;
}

type RedisClient = ReturnType<typeof createClient>;
interface StorageSession {
  readonly ready: Promise<RedisClient>;
  client?: RedisClient;
  closing?: Promise<void>;
  readonly socketLifetime: AbortController;
}

let session: StorageSession | undefined;

export async function connectStorage(connection: string | StorageConnectionOptions): Promise<RedisClient> {
  if (session) throw new Error("Valkey 已配置或正在关闭。");

  if (typeof connection === "string") {
    const protocol = URL.parse(connection)?.protocol;
    if (protocol !== "redis:" && protocol !== "rediss:") {
      throw new Error("LOTUS_VALKEY_URL 须为有效的 redis:// 或 rediss:// 地址。");
    }
  }

  const socketLifetime = new AbortController();
  const current: StorageSession = { ready: open(connection, socketLifetime.signal), socketLifetime };
  session = current;
  try {
    const client = await current.ready;
    if (current.closing) throw new Error("Valkey 正在关闭。");
    current.client = client;
    return client;
  } catch (error) {
    if (!current.closing) session = undefined;
    throw error;
  }
}

async function open(connection: string | StorageConnectionOptions, socketSignal: AbortSignal): Promise<RedisClient> {
  let redis: RedisClient | undefined;
  try {
    redis = createStorageClient(connection, socketSignal);
    redis.on("error", () => console.warn("[存储] Valkey 连接异常。"));
    await redis.connect();
    await redis.ping();
    return redis;
  } catch {
    if (redis?.isOpen) await redis.disconnect().catch(() => undefined);
    throw new Error(typeof connection === "string" ? "Valkey 连接失败，请检查服务状态和 LOTUS_VALKEY_URL。"
      : "Valkey 连接失败，请检查服务状态和连接配置。");
  }
}

export function createStorageClient(connection: string | StorageConnectionOptions, socketSignal?: AbortSignal) {
    const direct = typeof connection === "string" ? undefined : connection;
    return createClient({
      url: typeof connection === "string" ? connection : undefined,
      username: direct?.username,
      password: direct?.password,
      database: direct?.database,
      disableOfflineQueue: true,
      socket: {
        ...(socketSignal && { signal: socketSignal }),
        ...(direct?.socketPath ? { path: direct.socketPath } : direct && { host: direct.host, port: direct.port }),
        connectTimeout: 1_500,
        reconnectStrategy: (attempt) => attempt < 3 ? 200 * (attempt + 1) : false,
      },
    });
}

/** Cancellation for INFO reads stays outside node-redis 4's queue: its AbortSignal
 * listener can otherwise unlink an already-completed command during shutdown. */
export function readStorageCommand<T = unknown>(redis: Pick<RedisClient, "sendCommand">,
  args: readonly string[], signal?: AbortSignal): Promise<T> {
  if (!["INFO", "PING"].includes(args[0]?.toUpperCase() ?? "")) return Promise.reject(new Error("只读存储探测仅支持 INFO 或 PING。"));
  if (signal?.aborted) return Promise.reject(signal.reason);
  const pending = redis.sendCommand<T>([...args]);
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

export function closeStorage(): Promise<void> {
  const current = session;
  if (!current) return Promise.resolve();

  return current.closing ??= current.ready.then(async (redis) => {
    if (!redis.isOpen) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        redis.quit(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            // Abort the transport, never command queue nodes. This also closes a
            // blocked QUIT after node-redis has already marked isOpen=false.
            current.socketLifetime.abort();
            reject(new Error("Valkey 关闭超时，仍有在途命令或服务未响应。"));
          }, 5_000);
        }),
      ]);
    } catch (error) {
      current.socketLifetime.abort();
      throw error;
    } finally { clearTimeout(timer); }
  }, () => undefined).finally(() => {
    session = undefined;
  });
}

export type StorageWrite =
  | { readonly type: "set"; readonly key: string; readonly value: string; readonly ttlSeconds?: number }
  | { readonly type: "delete"; readonly key: string };

export function storage(namespace: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(namespace)) {
    throw new Error("存储模块名须由小写字母、数字和连字符组成。");
  }
  const redis = session?.closing ? undefined : session?.client;
  if (!redis) throw new Error("存储未配置，请设置 LOTUS_VALKEY_URL 或 redis.yaml。");

  function keyFor(key: string): string {
    if (key.length === 0) throw new Error("存储键不能为空。");
    return `lotus-yunzai:${namespace}:${key}`;
  }
  function expiration(ttlSeconds?: number) {
    if (ttlSeconds === undefined) return undefined;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 ||
        ttlSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
      throw new Error("存储过期时间须为有效的正整数秒数。");
    }
    return { EX: ttlSeconds };
  }

  return {
    get: (key: string) => redis.get(keyFor(key)),
    set: (key: string, value: string, ttlSeconds?: number) =>
      redis.set(keyFor(key), value, expiration(ttlSeconds)),
    delete: (key: string) => redis.del(keyFor(key)),
    async write(writes: readonly StorageWrite[]): Promise<void> {
      if (!writes.length) return;

      const transaction = redis.multi();
      for (const entry of writes) {
        const key = keyFor(entry.key);
        if (entry.type === "set") transaction.set(key, entry.value, expiration(entry.ttlSeconds));
        else transaction.del(key);
      }
      await transaction.exec();
    },
  };
}
