import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import type { connectStorage } from "@lotus-yunzai/storage";
import { formatShanghaiDate } from "./shanghai-date.ts";

type RedisClient = Awaited<ReturnType<typeof connectStorage>>;
type Direction = "receive" | "send";
type Identity = { readonly self_id?: number; readonly user_id?: number; readonly group_id?: number };
type Counts = { receive: string; send: string };

const kindPattern = /^[A-Za-z0-9_-]{1,32}$/u;
const scopePattern = /^(?:total|(?:bot|user|group):[1-9]\d*|(?:user|group):\*)$/u;
const bucketPattern = /^(?:total|\d{4}(?::\d{2}(?::\d{2})?)?)$/u;
const countUnavailable = () => new Error($t("lib.message-counts.text_527a2ec546"));

function countKey(direction: Direction, kind: string, scope: string, bucket: string): string {
  return `Yz:count:${direction}:${kind}:${scope}:${bucket}`;
}

function dateBuckets(date: Date): string[] {
  if (!Number.isFinite(date.getTime())) throw new Error($t("lib.message-counts.text_c598e94cab"));
  const day = formatShanghaiDate(date).replaceAll("-", ":");
  return [day, day.slice(0, 7), day.slice(0, 4), "total"];
}

function identityScopes({ self_id, user_id, group_id }: Identity): string[] {
  const keys = ["total"];
  for (const [scope, id] of [["bot", self_id], ["user", user_id], ["group", group_id]] as const) {
    if (id !== undefined && Number.isSafeInteger(id) && id > 0) keys.push(`${scope}:${id}`);
  }
  return keys;
}

function messageKinds(message: unknown, countSegments: boolean): Map<string, number> {
  const counts = new Map([["msg", 1]]);
  if (countSegments) {
    for (const part of Array.isArray(message) ? message : [message]) {
      const type = typeof part === "object" && part !== null && "type" in part ? part.type : undefined;
      const kind = typeof type === "string" && type ? type : "text";
      if (kind !== "msg" && kindPattern.test(kind)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return counts;
}

async function uniqueCount(redis: RedisClient, direction: Direction, kind: string, scope: string, bucket: string): Promise<string> {
  const head = `Yz:count:${direction}:${kind}:${scope.slice(0, -1)}`;
  const end = `:${bucket}`;
  const seen = new Set<string>();
  let cursor = 0;
  do {
    const page = await redis.scan(cursor, { MATCH: `${head}*${end}`, COUNT: 1_000 });
    for (const key of page.keys) {
      if (typeof key !== "string" || !key.startsWith(head) || !key.endsWith(end)) continue;
      const id = key.slice(head.length, -end.length);
      if (/^[1-9]\d*$/u.test(id)) seen.add(id);
    }
    cursor = page.cursor;
  } while (cursor !== 0);
  return String(seen.size);
}

function counter(value: string | null | undefined): string {
  return typeof value === "string" && /^\d+$/u.test(value) ? value : "0";
}

export function createMessageCounts(client: () => RedisClient | undefined, countSegments: boolean, now = () => new Date()) {
  async function record(direction: Direction, identity: Identity, message?: unknown): Promise<void> {
    const redis = client();
    if (!redis?.isReady) return;
    const scopes = identityScopes(identity);
    const buckets = dateBuckets(now());
    const transaction = redis.multi();
    for (const [kind, count] of messageKinds(message, countSegments)) {
      for (const scope of scopes) {
        for (const bucket of buckets) transaction.incrBy(countKey(direction, kind, scope, bucket), count);
      }
    }
    await transaction.exec();
  }

  async function read(kind: string, scope: string, bucket: string): Promise<Counts> {
    const redis = client();
    if (!redis?.isReady) throw countUnavailable();
    if (!kindPattern.test(kind) || !scopePattern.test(scope) || !bucketPattern.test(bucket)) {
      throw new Error($t("lib.message-counts.text_793cc1b2fa"));
    }
    try {
      if (scope.endsWith(":*")) {
        const [receive, send] = await Promise.all([
          uniqueCount(redis, "receive", kind, scope, bucket), uniqueCount(redis, "send", kind, scope, bucket),
        ]);
        return { receive, send };
      }

      const [receive, send] = await redis.mGet([
        countKey("receive", kind, scope, bucket), countKey("send", kind, scope, bucket),
      ]);
      return { receive: counter(receive), send: counter(send) };
    } catch {
      throw countUnavailable();
    }
  }

  return { available: () => client()?.isReady === true, record, read };
}
