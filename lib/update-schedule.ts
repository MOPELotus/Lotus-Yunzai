import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { withDefaultUpdateSchedule } from "./update-schedule-settings.ts";
import { HandlerScope } from "./plugins/handler.ts";
import { legacyHostCronTimeZone, LegacyTasks } from "./plugins/tasks.ts";

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
  console.warn($t("lib.update-schedule.text_f9db2c40b1"));
}

export function scheduleUpdates(
  config: Record<string, unknown>,
  run: () => void | Promise<void>,
): () => Promise<void> {
  config = withDefaultUpdateSchedule(config);
  const tasks = new LegacyTasks(undefined, legacyHostCronTimeZone);
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
      console.warn($t("lib.update-schedule.text_481a292f3f"));
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
      tasks.register(owner, { name: $t("lib.update-schedule.text_5007fd2d8e"), task: { cron: expression, fnc: trigger, log: false } });
    } catch {
      console.warn($t("lib.update-schedule.text_a446332553"));
    }
  }

  return () => {
    stopped = true;
    clearTimeout(timer);
    return cleanup ??= Promise.all([tasks.stop(), running]).then(() => undefined).finally(() => owner.dispose());
  };
}
