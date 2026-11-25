import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import type { MessageEvent } from "./messages.ts";

const pause = "#关机";
const resume = "#开机";
export const legacyRestartKey = "Yz:restart";

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
    [Math.floor(hours / 24), $t("lib.dispatch-power.text_49da61ceee")], [hours % 24, $t("lib.dispatch-power.text_7d58b6422c")], [minutes % 60, $t("lib.dispatch-power.text_b6a993c256")],
    [seconds % 60, $t("lib.dispatch-power.text_9dcdc2b289")], [elapsed % 1000, ""],
  ] as const;
  return parts.map(([amount, unit]) => amount ? `${amount}${unit}` : "").join("") || $t("lib.dispatch-power.text_b69efa8606");
}

export function createDispatchPower(now = Date.now, pausedAt?: number, persist?: (pausedAt?: number) => void) {
  let paused = pausedAt !== undefined;
  let since = pausedAt ?? now();
  let active = new AbortController();
  if (paused) active.abort();

  function changePaused(value: boolean, timestamp: number, save?: (pausedAt?: number) => void): string | undefined {
    if (paused === value) return;
    save?.(value ? timestamp : undefined);
    const elapsed = formatElapsed(timestamp - since);
    since = timestamp;
    paused = value;
    if (paused) active.abort();
    else active = new AbortController();
    return paused ? $t("lib.dispatch-power.text_4c1e4e628b", { "elapsed": elapsed }) : $t("lib.dispatch-power.text_e4f3b86506", { "elapsed": elapsed });
  }

  function setPaused(value: boolean): string | undefined {
    return changePaused(value, now(), persist);
  }

  return {
    get paused() { return paused; },
    get pausedAt() { return paused ? since : undefined; },
    get activeSignal() { return active.signal; },
    setPaused,
    restorePaused(timestamp: number) { changePaused(true, timestamp); },
    async handle(event: MessageEvent): Promise<void> {
      if (!isProcessMaster(event) ||
          (event.adapter !== "milky" && event.message_type !== "terminal" && event.boundAccount !== true)) return;
      if (event.msg !== (paused ? resume : pause)) return;

      let message: string | undefined;
      try {
        message = setPaused(!paused);
      } catch {
        message = $t("lib.dispatch-power.text_6f1efb141b");
      }
      if (message !== undefined) await event.reply(message);
    },
  };
}
