import { scheduleJob, type Job } from "node-schedule";
import type { HandlerScope } from "./handler.ts";

interface ScheduledTask {
  readonly owner: HandlerScope;
  readonly job: Job;
  running?: Promise<void>;
}

export class LegacyTasks {
  readonly #tasks = new Map<string, ScheduledTask>();
  #stopping?: Promise<void>;

  register(owner: HandlerScope, app: Record<string, unknown>): void {
    if (this.#stopping || app.task === undefined || app.task === null) return;

    for (const value of Array.isArray(app.task) ? app.task : [app.task]) {
      if (typeof value !== "object" || value === null) {
        throw new Error(`插件 ${app.name} 的定时任务格式无效。`);
      }
      const task = value as Record<string, unknown>;
      if (!task.cron && !task.fnc) continue;

      const name = typeof task.name === "string" && task.name.trim() ? task.name.trim() : String(app.name);
      const cron = typeof task.cron === "string" ? task.cron.trim().replace(/\s+/gu, " ") : "";
      const fields = cron.split(" ").length;
      const callback = typeof task.fnc === "string" ? app[task.fnc] : task.fnc;
      if ((fields !== 5 && fields !== 6) || typeof callback !== "function") {
        throw new Error(`任务 ${name} 需要五段或六段 cron 及可调用的方法。`);
      }

      const key = JSON.stringify([name, cron]);
      if (this.#tasks.has(key)) {
        console.warn(`[任务] 跳过重复任务 ${name}（${cron}）。`);
        continue;
      }

      const job = scheduleJob(cron, () => {
        const current = this.#tasks.get(key);
        if (current?.job !== job || current.running) return;

        current.running = Promise.resolve()
          .then(async () => {
            if (task.log !== false) console.log(`[任务] 开始执行 ${name}。`);
            await owner.run(() => callback.call(app));
          })
          .catch((error: unknown) => {
            console.warn(`[任务] ${name} 执行失败：`, error);
          })
          .finally(() => {
            current.running = undefined;
          });
      });
      if (!job) throw new Error(`任务 ${name} 的 cron 无效或没有下一次触发时间：${cron}`);
      this.#tasks.set(key, { owner, job });
    }
  }

  stop(): Promise<void> {
    return this.#stopping ??= this.cancel();
  }

  async cancel(owners?: ReadonlySet<HandlerScope>): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [key, task] of this.#tasks) {
      if (owners && !owners.has(task.owner)) continue;

      this.#tasks.delete(key);
      task.job.cancel();
      if (task.running) pending.push(task.running);
    }
    await Promise.all(pending);
  }
}
