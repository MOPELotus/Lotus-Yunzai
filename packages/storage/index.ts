import { createClient } from "redis";

export { createRoleJsonArchive, type AcquireRoleArchiveLock } from "./role-json-archive.ts";

export interface StorageConnectionOptions {
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

  const current: StorageSession = { ready: open(connection) };
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

async function open(connection: string | StorageConnectionOptions): Promise<RedisClient> {
  let redis: RedisClient | undefined;
  try {
    const direct = typeof connection === "string" ? undefined : connection;
    redis = createClient({
      url: typeof connection === "string" ? connection : undefined,
      username: direct?.username,
      password: direct?.password,
      database: direct?.database,
      disableOfflineQueue: true,
      socket: {
        ...(direct && { host: direct.host, port: direct.port }),
        connectTimeout: 1_500,
        reconnectStrategy: (attempt) => attempt < 3 ? 200 * (attempt + 1) : false,
      },
    });
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

export function closeStorage(): Promise<void> {
  const current = session;
  if (!current) return Promise.resolve();

  return current.closing ??= current.ready.then(async (redis) => {
    if (redis.isOpen) await redis.disconnect();
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
