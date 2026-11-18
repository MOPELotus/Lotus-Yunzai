import { HandlerScope } from "./plugins/handler.ts";
import { LegacyTasks } from "./plugins/tasks.ts";

const maxTimerDelay = 2_147_483_647;
const decimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;

function updateInterval(value: unknown): number | undefined {
  if (!value) return;
  const minutes = typeof value === "string" && decimal.test(value.trim()) ? Number(value) : value;
  if (typeof minutes === "number") {
    if (minutes === 0) return;
    const delay = Math.ceil(minutes * 60_000);
    if (delay > 0 && Number.isSafeInteger(delay)) return delay;
  }
  console.warn("[任务] 跳过 bot.yaml 中无效的 update_time。");
}

export function scheduleUpdates(
  config: Record<string, unknown>,
  run: () => void | Promise<void>,
): () => Promise<void> {
  const tasks = new LegacyTasks();
  const owner = new HandlerScope();
  const interval = updateInterval(config.update_time);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let stopped = false;

  function trigger(): Promise<void> | undefined {
    if (stopped || running) return running;
    running = Promise.resolve().then(() => {
      if (!stopped) return run();
    }).catch(() => {
      console.warn("[任务] 定时更新执行失败。");
    }).finally(() => {
      running = undefined;
    });
    return running;
  }

  function waitForDelay(remaining: number): void {
    const delay = Math.min(remaining, maxTimerDelay);
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      if (remaining > delay) waitForDelay(remaining - delay);
      else void trigger()?.then(() => {
        if (!stopped && interval !== undefined) waitForDelay(interval);
      });
    }, delay);
  }

  if (interval !== undefined) waitForDelay(interval);
  const cron = config.update_cron;
  for (const expression of Array.isArray(cron) ? cron : [cron]) {
    if (!expression) continue;
    try {
      tasks.register(owner, { name: "定时更新", task: { cron: expression, fnc: trigger, log: false } });
    } catch {
      console.warn("[任务] 跳过 bot.yaml 中无效的 update_cron。");
    }
  }

  return () => {
    stopped = true;
    clearTimeout(timer);
    return cleanup ??= Promise.all([tasks.stop(), running]).then(() => undefined).finally(() => owner.dispose());
  };
}
