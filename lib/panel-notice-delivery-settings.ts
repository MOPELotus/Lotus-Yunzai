import { isDeepStrictEqual } from "node:util";
import type { NoticeRedis } from "../plugins/notice/store.ts";
import { readPanelJson } from "./panel.ts";

type Redis = Pick<NoticeRedis, "eval">;
type Document = Record<string, unknown>;
type Channel = { key: string; label: string; storage: string };

const gameNames = { gs: "原神", sr: "星铁", zzz: "绝区零" };
const channels: Channel[] = Object.entries(gameNames).flatMap(([game, name]) =>
  [["announce", "公告", "targets"], ["info", "资讯", "info-targets"],
    ...(game === "zzz" ? [] : [["activity", "活动到期", "activity-targets"]])].map(([kind, label, suffix]) => ({
    key: game + kind, label: name + label + "群内订阅覆盖", storage: `lotus-yunzai:notice:mys:${game}:${suffix}`,
  })));
const fields = [
  { key: "whitelist", label: "公告全局白名单", type: "list" },
  { key: "blacklist", label: "公告全局黑名单", type: "list" },
  { key: "accounts", label: "在线机器人的公告推送配置", type: "json",
    hint: "以机器人 QQ 为键。enabled 为开关，pushInterval 为毫秒（500–10000），whitelist 和 blacklist 为群号数组。retryCount 是兼容旧配置保留的字段，当前投递只尝试一次。" },
  ...channels.map(({ key, label }) => ({ key, label, type: "json", hint: "以“机器人QQ:群号”为键。on 强制启用，off 强制停用，删掉该项后按 YAML 基础名单。" })),
] as const;

const globalKeys = ["notice:whitelist", "notice:blacklist"];
const accountFields = ["whitelist", "blacklist", "enabled", "pushInterval", "retryCount"] as const;
const limits = { pushInterval: [500, 10_000], retryCount: [0, 10] } as const;
const id = /^[1-9]\d*$/u;
const target = /^[1-9]\d*:[1-9]\d*$/u;

// One stable snapshot is checked again in the same Valkey script as the writes.
// Notice commands continue using their original keys and can race without lost edits.
const atomic = `
local accounts = tonumber(ARGV[1])
local output = {}
for i = 1, #KEYS do
  local key = KEYS[i]
  if i <= 2 then
    local values = redis.call('SMEMBERS', key)
    table.sort(values)
    output[i] = values
  elseif i <= 2 + accounts then
    output[i] = redis.call('HMGET', key, 'whitelist', 'blacklist', 'enabled', 'pushInterval', 'retryCount')
  else
    local items, pairs = redis.call('HGETALL', key), {}
    for j = 1, #items, 2 do pairs[#pairs + 1] = {items[j], items[j + 1]} end
    table.sort(pairs, function(a, b) return a[1] < b[1] end)
    output[i] = pairs
  end
end
local snapshot = cjson.encode(output)
if #ARGV == 1 then return snapshot end
if redis.sha1hex(snapshot) ~= ARGV[2] then return 0 end
local patch = cjson.decode(ARGV[3])
for _, item in ipairs(patch) do
  local index, action, field, value = unpack(item)
  if value == nil then redis.call(action, KEYS[index], field)
  else redis.call(action, KEYS[index], field, value) end
  if index > 2 and index <= 2 + accounts then
    redis.call('EXPIRE', KEYS[index], 2592000)
  end
end
return 1
`;

class InvalidNoticeDeliverySettings extends Error {}

function record(value: unknown): Document | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Document : undefined;
}

function invalid(): never {
  throw new InvalidNoticeDeliverySettings();
}

function groupIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5000) return invalid();
  const values = value.map((group) => {
    if (typeof group === "number" && Number.isSafeInteger(group) && group > 0) return String(group);
    if (typeof group === "string" && id.test(group)) return group;
    return invalid();
  });
  return [...new Set(values)].sort();
}

function interval(value: unknown, field: keyof typeof limits): number {
  const [min, max] = limits[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return invalid();
  return value;
}

function overrides(value: unknown) {
  const supplied = record(value);
  if (!supplied || Object.keys(supplied).length > 5000) return invalid();
  const pairs = Object.entries(supplied).map(([key, state]) => {
    if (!target.test(key) || key.split(":").some(part => !Number.isSafeInteger(Number(part))) ||
        (state !== "on" && state !== "off")) return invalid();
    return [key, state] as const;
  });
  return Object.fromEntries(pairs.sort(([left], [right]) => left.localeCompare(right)));
}

function accountSnapshot(raw: unknown) {
  if (!Array.isArray(raw) || raw.length !== 5) throw new Error("公告账号配置无效");
  const [whitelist, blacklist, enabled, delay, retry] = raw;
  const bounded = (value: unknown, field: keyof typeof limits, fallback: number) => {
    const parsed = Number(value);
    const [min, max] = limits[field];
    return value !== false && Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  if (enabled !== false && enabled !== "true" && enabled !== "false" &&
      (typeof enabled !== "string" || !/^-?\d+$/u.test(enabled))) throw new Error("公告账号开关无效");
  return {
    enabled: enabled === false || enabled === "true" || enabled !== "false" && Number(enabled) !== 0,
    pushInterval: bounded(delay, "pushInterval", 2000),
    retryCount: bounded(retry, "retryCount", 3),
    whitelist: groupIds(whitelist === false ? [] : JSON.parse(whitelist)),
    blacklist: groupIds(blacklist === false ? [] : JSON.parse(blacklist)),
  };
}

type Operation = [index: number, action: "HSET" | "HDEL" | "SADD" | "SREM", field: string, value?: string];

export function panelNoticeDeliverySettings(getRedis: () => Redis | undefined, onlineBots: () => readonly number[]) {
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    const active = () => !request.signal.aborted && stillAuthorized();
    if (!active()) return new Response(null, { status: 401 });
    if (request.method !== "GET" && request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
    const redis = getRedis();
    if (!redis) return new Response(null, { status: 503 });
    const bots = () => [...new Set(onlineBots().filter((value) => Number.isSafeInteger(value) && value > 0).map(String))].sort();
    const accounts = bots();
    const keys = [...globalKeys, ...accounts.map(qq => `notice:account:${qq}:config`), ...channels.map(({ storage }) => storage)];
    try {
      const raw = await redis.eval(atomic, { keys, arguments: [String(accounts.length)] });
      if (typeof raw !== "string") throw new Error("公告配置快照无效");
      const snapshot: unknown = JSON.parse(raw);
      if (!Array.isArray(snapshot) || snapshot.length !== keys.length) throw new Error("公告配置快照无效");
      const values = {
        whitelist: groupIds(Array.isArray(snapshot[0]) ? snapshot[0] : []),
        blacklist: groupIds(Array.isArray(snapshot[1]) ? snapshot[1] : []),
        accounts: Object.fromEntries(accounts.map((qq, i) => [qq, accountSnapshot(snapshot[i + 2])])) as Record<string, ReturnType<typeof accountSnapshot>>,
        ...Object.fromEntries(channels.map(({ key }, i) => {
          const pairs = snapshot[i + accounts.length + 2];
          const valid = Array.isArray(pairs) ? pairs.filter(([id, state]) => typeof id === "string" && target.test(id) &&
            id.split(":").every((part) => Number.isSafeInteger(Number(part))) && (state === "on" || state === "off")) : [];
          return [key, overrides(Object.fromEntries(valid))];
        })),
      };
      if (request.method === "GET") return active() ? Response.json({ fields, values }) : new Response(null, { status: 401 });

      let body: Document | undefined;
      try { body = record(await readPanelJson(request)); }
      catch { return new Response(null, { status: 400 }); }
      const proposed = record(body?.values);
      if (!body || Object.keys(body).length !== 2 || !record(body.previous) || !proposed) return invalid();
      if (!isDeepStrictEqual(body.previous, values)) return new Response(null, { status: 409 });
      const operations: Operation[] = [];
      for (const [key, value] of Object.entries(proposed)) {
        if (key === "whitelist" || key === "blacklist") {
          const index = key === "whitelist" ? 1 : 2;
          const before = values[key], after = groupIds(value);
          const existing = new Set(before), wanted = new Set(after);
          for (const group of existing) if (!wanted.has(group)) operations.push([index, "SREM", group]);
          for (const group of wanted) if (!existing.has(group)) operations.push([index, "SADD", group]);
          values[key] = after;
        } else if (key === "accounts") {
          const supplied = record(value);
          if (!supplied) return invalid();
          for (const [qq, settings] of Object.entries(supplied)) {
            const accountIndex = accounts.indexOf(qq);
            const account = record(settings);
            if (accountIndex < 0 || !account || Object.keys(account).some(field => !(accountFields as readonly string[]).includes(field))) return invalid();
            const current = values.accounts[qq]!;
            let field: typeof accountFields[number];
            for (field of accountFields) {
              if (!Object.hasOwn(account, field)) continue;
              const input = account[field];
              if (field === "whitelist" || field === "blacklist") {
                const list = groupIds(input);
                if (!isDeepStrictEqual(list, current[field])) operations.push([accountIndex + 3, "HSET", field, JSON.stringify(list)]);
                current[field] = list;
              } else if (field === "enabled") {
                if (typeof input !== "boolean") return invalid();
                if (input !== current.enabled) operations.push([accountIndex + 3, "HSET", field, String(input)]);
                current.enabled = input;
              } else {
                const number = interval(input, field);
                if (number !== current[field]) operations.push([accountIndex + 3, "HSET", field, String(number)]);
                current[field] = number;
              }
            }
          }
        } else {
          const channel = channels.findIndex((item) => item.key === key);
          if (channel < 0) return invalid();
          const index = channel + accounts.length + 3;
          const before = (values as Record<string, unknown>)[key] as Record<string, "on" | "off">;
          const after = overrides(value);
          for (const id of Object.keys(before)) if (!Object.hasOwn(after, id)) operations.push([index, "HDEL", id]);
          for (const [id, state] of Object.entries(after)) if (before[id] !== state) operations.push([index, "HSET", id, state]);
          (values as Record<string, unknown>)[key] = after;
        }
      }
      if (!active()) return new Response(null, { status: 401 });
      if (redis !== getRedis() || !isDeepStrictEqual(bots(), accounts)) return new Response(null, { status: 409 });
      if (operations.length) {
        const hash = new Bun.CryptoHasher("sha1").update(raw).digest("hex");
        const success = await redis.eval(atomic, { keys, arguments: [String(accounts.length), hash, JSON.stringify(operations)] });
        if (success !== 1) return new Response(null, { status: 409 });
      }
      return Response.json({ fields, values });
    } catch (error) {
      return new Response(null, { status: error instanceof InvalidNoticeDeliverySettings ? 400 : 500 });
    }
  };
}
