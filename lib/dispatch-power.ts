import type { MessageEvent } from "./messages.ts";

const pause = "#关机";
const resume = "#开机";
const legacyRestartKey = "Yz:restart";

export async function readLegacyDispatchPause(redis: {
  get(key: string): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}) {
  const snapshot = await redis.get(legacyRestartKey);
  if (!snapshot) return;
  let state: { isStop?: unknown; time?: unknown } | null;
  try { state = JSON.parse(snapshot); }
  catch { return; }
  if (!state || state.isStop !== true || typeof state.time !== "number" ||
      !Number.isSafeInteger(state.time) || state.time <= 0) return;

  return {
    pausedAt: state.time,
    async take() {
      return await redis.eval(`
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
      `, { keys: [legacyRestartKey], arguments: [snapshot] }) === 1;
    },
  };
}

export function isProcessMaster(event: MessageEvent): boolean {
  return event.adapter === "milky" ? event.canManageProcess === true : event.isMaster === true;
}

export function formatElapsed(milliseconds: number): string {
  const elapsed = Math.max(0, Math.floor(milliseconds));
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const parts = [
    [Math.floor(hours / 24), "天"], [hours % 24, "时"], [minutes % 60, "分"],
    [seconds % 60, "秒"], [elapsed % 1000, ""],
  ] as const;
  return parts.map(([amount, unit]) => amount ? `${amount}${unit}` : "").join("") || "0秒";
}

export function createDispatchPower(now = Date.now, pausedAt?: number) {
  let paused = pausedAt !== undefined;
  let since = pausedAt ?? now();
  let active = new AbortController();
  if (paused) active.abort();

  function setPaused(value: boolean, timestamp = now()): string | undefined {
    if (paused === value) return;
    const elapsed = formatElapsed(timestamp - since);
    since = timestamp;
    paused = value;
    if (paused) active.abort();
    else active = new AbortController();
    return paused ? `关机成功，本次运行时长${elapsed}` : `开机成功，距离上次关机${elapsed}`;
  }

  return {
    get paused() { return paused; },
    get pausedAt() { return paused ? since : undefined; },
    get activeSignal() { return active.signal; },
    setPaused,
    async handle(event: MessageEvent): Promise<void> {
      if (!isProcessMaster(event) ||
          (event.adapter !== "milky" && event.message_type !== "terminal" && event.boundAccount !== true)) return;
      if (event.msg !== (paused ? resume : pause)) return;

      const message = setPaused(!paused);
      if (message !== undefined) await event.reply(message);
    },
  };
}
