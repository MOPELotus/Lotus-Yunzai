import { HandlerScope } from "./plugins/handler.ts";
import { LegacyTasks } from "./plugins/tasks.ts";

export function scheduleDispatchPower(config: Record<string, unknown>, setPaused: (paused: boolean) => void | Promise<void>) {
  const tasks = new LegacyTasks();
  const owner = new HandlerScope();
  for (const [field, name, paused] of [
    ["stop_cron", "定时关机", true],
    ["start_cron", "定时开机", false],
  ] as const) {
    const value = config[field];
    for (const cron of Array.isArray(value) ? value : [value]) {
      if (!cron) continue;
      try {
        tasks.register(owner, { name, task: { cron, fnc: () => setPaused(paused) } });
      } catch {
        console.warn(`[任务] 跳过 bot.yaml 中无效的 ${field}。`);
      }
    }
  }
  return () => tasks.stop();
}
