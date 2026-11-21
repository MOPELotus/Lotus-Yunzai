import { legacyRestartKey } from "./dispatch-power.ts";
import type { ProcessReceipt } from "./process-receipts.ts";

const pendingKey = "lotus-yunzai:process:legacy-restart-targets";
const pendingSeconds = 30 * 24 * 60 * 60;

interface Storage {
  get(key: string): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

type Target = ProcessReceipt["target"];
type Route = { readonly type: "broadcast" } | Exclude<Target, { type: "masters" }>;
type LegacyReceipt = Extract<ProcessReceipt, { kind: "stop" | "restart" }>;
interface Claim {
  readonly receipt: LegacyReceipt;
  restore(): Promise<void>;
}

function id(value: unknown): number | undefined {
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function decode(raw: string): { at: number; kind: "stop" | "restart"; route: Route } | undefined {
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw); }
  catch { return; }
  if (!data || data.isStop || (data.isExit !== undefined && typeof data.isExit !== "boolean") ||
      typeof data.time !== "number" || !id(data.time)) return;
  const { group_id: group, user_id: user, bot_id: bot } = data;
  const botId = id(bot);
  let route: Route;
  if (group !== undefined) {
    const groupId = id(group);
    if (!botId || !groupId) return;
    route = { type: "group", botId, id: groupId };
  } else if (user !== undefined) {
    if (bot === "stdin" && user === "stdin") route = { type: "terminal" };
    else {
      const userId = id(user);
      if (!botId || !userId) return;
      route = { type: "private", botId, id: userId };
    }
  } else {
    if (bot !== undefined) return;
    route = { type: "broadcast" };
  }
  return { at: data.time, kind: data.isExit ? "stop" : "restart", route };
}

function routeSlot(target: Target): string {
  return target.type === "terminal" ? "terminal" : String(target.botId);
}

export async function takeLegacyProcessReceipt(redis: Storage, session: {
  readonly botId?: number;
  readonly adapter?: "milky";
  readonly signal: AbortSignal;
}, configured: { readonly bots: readonly number[]; readonly terminal: boolean }): Promise<Claim | undefined> {
  const { botId, adapter, signal } = session;
  if (signal.aborted || (botId === undefined && !configured.terminal)) return;
  const slot = botId === undefined ? "terminal" : String(botId);
  const old = await redis.get(legacyRestartKey);
  const decoded = old ? decode(old) : undefined;
  if (old && decoded && !signal.aborted) {
    const slots = decoded.route.type === "broadcast"
      ? [...configured.bots.map(String), ...(configured.terminal ? ["terminal"] : [])]
      : [routeSlot(decoded.route)];
    if (slots.includes(slot)) {
      // Keep destinations that connect later across supervisor or worker restarts.
      await redis.eval(`
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
        for index = 3, #ARGV do redis.call('HSET', KEYS[2], ARGV[index], ARGV[1]) end
        redis.call('EXPIRE', KEYS[2], ARGV[2])
        return redis.call('DEL', KEYS[1])
      `, { keys: [legacyRestartKey, pendingKey], arguments: [old, String(pendingSeconds), ...slots] });
    }
  }
  if (signal.aborted) return;
  const entry = await redis.eval(`
    local entry = redis.call('HGET', KEYS[1], ARGV[1])
    if entry then redis.call('HDEL', KEYS[1], ARGV[1]) end
    return entry
  `, { keys: [pendingKey], arguments: [slot] });
  if (typeof entry !== "string") return;
  const raw = entry;
  async function restore() {
    await redis.eval(`
      if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 and redis.call('TTL', KEYS[1]) == -1 then
        redis.call('EXPIRE', KEYS[1], ARGV[3])
      end
    `, { keys: [pendingKey], arguments: [slot, raw, String(pendingSeconds)] });
  }
  if (signal.aborted) {
    await restore();
    return;
  }
  const receipt = decode(raw);
  if (!receipt) return;
  const { at, kind, route } = receipt;
  if (route.type !== "broadcast" && routeSlot(route) !== slot) return;
  if (botId === undefined) return { receipt: { at, kind, target: { type: "terminal" } }, restore };
  if (route.type === "terminal") return;
  const target: Target = route.type === "broadcast" ? { type: "masters", botId } : route;
  return { receipt: { at, kind, target: { ...target, ...(adapter && { adapter }) } }, restore };
}
