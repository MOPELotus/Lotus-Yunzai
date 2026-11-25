import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { isDeepStrictEqual } from "node:util";
import type { NoticeRedis } from "../plugins/notice/store.ts";
import { readPanelJson } from "./panel.ts";
import { panelMysActivityGames, panelMysNoticeGames } from "./panel-notice-settings.ts";

type Redis = Pick<NoticeRedis, "eval">;
type Document = Record<string, unknown>;
type Channel = { key: string; label: string; storage: string };

const channels: Channel[] = Object.entries(panelMysNoticeGames).flatMap(([game, name]) =>
  [["announce", $t("lib.panel-notice-delivery-settings.text_069c0ecbf8"), "targets"], ["info", $t("lib.panel-notice-delivery-settings.text_71d9a93075"), "info-targets"],
    ...(panelMysActivityGames.some(active => active === game) ? [["activity", $t("lib.panel-notice-delivery-settings.text_3c28e111e2"), "activity-targets"]] : [])].map(([kind, label, suffix]) => ({
    key: game + kind, label: name + label + $t("lib.panel-notice-delivery-settings.text_8b1587b7f0"), storage: `lotus-yunzai:notice:mys:${game}:${suffix}`,
  })));
const fields = [
  { key: "whitelist", label: $t("lib.panel-notice-delivery-settings.text_2d26c33661"), type: "list" },
  { key: "blacklist", label: $t("lib.panel-notice-delivery-settings.text_e9159ce5da"), type: "list" },
  { key: "accounts", label: $t("lib.panel-notice-delivery-settings.text_661b96b2e9"), type: "json",
    hint: $t("lib.panel-notice-delivery-settings.text_6b4f8bfd6f") },
  ...channels.map(({ key, label }) => ({ key, label, type: "json", hint: $t("lib.panel-notice-delivery-settings.text_f78398cadf") })),
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
  if (!Array.isArray(raw) || raw.length !== 5) throw new Error($t("lib.panel-notice-delivery-settings.text_adbc9d11b5"));
  const [whitelist, blacklist, enabled, delay, retry] = raw;
  const bounded = (value: unknown, field: keyof typeof limits, fallback: number) => {
    const parsed = Number(value);
    const [min, max] = limits[field];
    return value !== false && Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  if (enabled !== false && enabled !== "true" && enabled !== "false" &&
      (typeof enabled !== "string" || !/^-?\d+$/u.test(enabled))) throw new Error($t("lib.panel-notice-delivery-settings.text_b558403329"));
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
      if (typeof raw !== "string") throw new Error($t("lib.panel-notice-delivery-settings.text_33f73f78d7"));
      const snapshot: unknown = JSON.parse(raw);
      if (!Array.isArray(snapshot) || snapshot.length !== keys.length) throw new Error($t("lib.panel-notice-delivery-settings.text_33f73f78d7"));
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
