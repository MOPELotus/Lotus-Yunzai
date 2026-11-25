import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { HandlerScope } from "./plugins/handler.ts";
import { legacyHostCronTimeZone, LegacyTasks } from "./plugins/tasks.ts";

const maxTimerDelay = 2_147_483_647;

export function scheduleProcessRestart(
  config: Record<string, unknown>,
  restart: () => void | Promise<void>,
): () => Promise<void> {
  const tasks = new LegacyTasks(undefined, legacyHostCronTimeZone);
  const owner = new HandlerScope();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let stopped = false;
  let lastStartedSecond: number | undefined;

  function trigger(): Promise<void> | undefined {
    if (stopped || running) return running;
    // Six-field cron has second precision. A timer due in the same second joins it.
    const second = Math.floor(Date.now() / 1_000);
    if (second === lastStartedSecond) return;
    lastStartedSecond = second;
    running = Promise.resolve().then(() => {
      if (!stopped) return restart();
    }).catch(() => {
      console.warn($t("lib.process-restart-schedule.text_ec99551038"));
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
      else void trigger();
    }, delay);
  }

  const time = config.restart_time;
  if (time) {
    const minutes = typeof time === "number" || typeof time === "string" ? Number(time) : NaN;
    const milliseconds = Math.ceil(minutes * 60_000);
    if (Number.isSafeInteger(milliseconds) && minutes > 0) waitForDelay(milliseconds);
    else if (minutes !== 0) console.warn($t("lib.process-restart-schedule.text_6b923403b1"));
  }

  const cron = config.restart_cron;
  for (const expression of Array.isArray(cron) ? cron : [cron]) {
    if (!expression) continue;
    try {
      tasks.register(owner, { name: $t("lib.process-restart-schedule.text_562788fd33"), task: { cron: expression, fnc: trigger } });
    } catch {
      console.warn($t("lib.process-restart-schedule.text_f23ea4f247"));
    }
  }

  return () => {
    stopped = true;
    clearTimeout(timer);
    return cleanup ??= Promise.all([tasks.stop(), running]).then(() => undefined).finally(() => owner.dispose());
  };
}
