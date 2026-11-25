import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { HandlerScope } from "./plugins/handler.ts";
import { legacyHostCronTimeZone, LegacyTasks } from "./plugins/tasks.ts";

export function scheduleDispatchPower(config: Record<string, unknown>, setPaused: (paused: boolean) => void | Promise<void>) {
  const tasks = new LegacyTasks(undefined, legacyHostCronTimeZone);
  const owner = new HandlerScope();
  for (const [field, name, paused] of [
    ["stop_cron", $t("lib.dispatch-power-schedule.text_3a545518bd"), true],
    ["start_cron", $t("lib.dispatch-power-schedule.text_5e55e9df17"), false],
  ] as const) {
    const value = config[field];
    for (const cron of Array.isArray(value) ? value : [value]) {
      if (!cron) continue;
      try {
        tasks.register(owner, { name, task: { cron, fnc: () => setPaused(paused) } });
      } catch {
        console.warn($t("lib.dispatch-power-schedule.text_19862731dc", { "field": field }));
      }
    }
  }
  return () => tasks.stop();
}
