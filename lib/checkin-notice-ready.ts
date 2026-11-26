import { setTimeout as delay } from 'node:timers/promises';

export async function waitForCheckinNoticeTransport({
  available, signal, timeoutMs = 60_000, now = Date.now,
  pause = (ms, active) => delay(ms, undefined, { signal: active }),
}: {
  available: () => boolean;
  signal: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  pause?: (ms: number, signal: AbortSignal) => Promise<unknown>;
}): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (!signal.aborted) {
    if (available()) return true;
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    try { await pause(Math.min(250, remaining), signal); } catch { return false; }
  }
  return false;
}
