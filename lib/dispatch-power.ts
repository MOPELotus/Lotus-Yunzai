import type { MessageEvent } from "./messages.ts";

const pause = "#关机";
const resume = "#开机";

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

  function setPaused(value: boolean): string | undefined {
    if (paused === value) return;
    const timestamp = now();
    const elapsed = formatElapsed(timestamp - since);
    since = timestamp;
    paused = value;
    return paused ? `关机成功，本次运行时长${elapsed}` : `开机成功，距离上次关机${elapsed}`;
  }

  return {
    get paused() { return paused; },
    get pausedAt() { return paused ? since : undefined; },
    setPaused,
    async handle(event: MessageEvent): Promise<void> {
      if (event.isMaster !== true || (event.message_type !== "terminal" && event.boundAccount !== true)) return;
      if (event.msg !== (paused ? resume : pause)) return;

      const message = setPaused(!paused);
      if (message !== undefined) await event.reply(message);
    },
  };
}
