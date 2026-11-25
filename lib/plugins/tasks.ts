import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { Job, scheduledJobs } from "node-schedule";
import type { HandlerScope } from "./handler.ts";

export const legacyHostCronTimeZone = "Asia/Shanghai";

interface TaskDefinition {
  readonly key: string;
  readonly name: string;
  readonly cron: string;
  readonly log: boolean;
  invoke(): unknown;
}

interface ScheduledTask {
  readonly name: string;
  readonly cron: string;
  readonly owner: HandlerScope;
  readonly job: Job;
}

interface RunningTask {
  readonly owner: HandlerScope;
  readonly completion: Promise<void>;
}

interface TaskEntry {
  readonly owner: HandlerScope;
  readonly app: Record<string, unknown>;
}

interface PreparedTasks {
  publish(): void;
  cancel(): void;
}

function* definitions(app: Record<string, unknown>): Iterable<TaskDefinition> {
  if (app.task === undefined || app.task === null) return;
  for (const value of Array.isArray(app.task) ? app.task : [app.task]) {
    if (typeof value !== "object" || value === null) {
      throw new Error($t("lib.plugins.tasks.text_768c57158c", { "name": app.name }));
    }
    const task = value as Record<string, unknown>;
    if (!task.cron && !task.fnc) continue;

    const name = typeof task.name === "string" && task.name.trim() ? task.name.trim() : String(app.name);
    const cron = typeof task.cron === "string" ? task.cron.trim().replace(/\s+/gu, " ") : "";
    const fields = cron.split(" ").length;
    const callback = typeof task.fnc === "string" ? app[task.fnc] : task.fnc;
    if ((fields !== 5 && fields !== 6) || typeof callback !== "function") {
      throw new Error($t("lib.plugins.tasks.text_a71a7daf61", { "name": name }));
    }
    yield {
      key: JSON.stringify([name, cron]), name, cron,
      get log() { return task.log !== false; },
      invoke: () => callback.call(app),
    };
  }
}

function warnDuplicate({ name, cron }: Pick<TaskDefinition, "name" | "cron">) {
  console.warn($t("lib.plugins.tasks.text_8f877cdeab", { "name": name, "cron": cron }));
}

export class LegacyTasks {
  readonly #tasks = new Map<string, ScheduledTask>();
  readonly #running = new Map<string, RunningTask>();
  readonly #preparations = new Set<() => void>();
  #stopping?: Promise<void>;

  constructor(
    private readonly accepting: () => boolean = () => true,
    private readonly timeZone?: string,
  ) {}

  register(owner: HandlerScope, app: Record<string, unknown>): void {
    if (this.#stopping) return;
    for (const task of definitions(app)) {
      if (this.#tasks.has(task.key)) {
        warnDuplicate(task);
        continue;
      }
      this.#tasks.set(task.key, this.#schedule(owner, task));
    }
  }

  prepare(entries: readonly TaskEntry[], replacingOwners: ReadonlySet<HandlerScope> = new Set()): PreparedTasks {
    if (this.#stopping) return { publish() {}, cancel() {} };
    const replacing = new Set(replacingOwners);
    const staged = new Map<string, ScheduledTask>();
    const discard = () => {
      for (const task of staged.values()) task.job.cancel();
      staged.clear();
    };
    try {
      for (const { owner, app } of entries) {
        for (const task of definitions(app)) {
          const live = this.#tasks.get(task.key);
          if (staged.has(task.key) || (live && !replacing.has(live.owner))) {
            warnDuplicate(task);
            continue;
          }
          const prepared = this.#schedule(owner, task);
          // Retain the validated recurrence while hiding the prepared job from both live registries.
          delete scheduledJobs[prepared.job.name];
          staged.set(task.key, prepared);
        }
      }
    } catch (error) {
      discard();
      throw error;
    }

    const cancel = () => {
      if (this.#preparations.delete(cancel)) discard();
    };
    this.#preparations.add(cancel);
    return {
      cancel,
      publish: () => {
        if (!this.#preparations.delete(cancel)) return;
        this.#retire(replacing);
        for (const [key, task] of staged) {
          if (this.#tasks.has(key)) {
            task.job.cancel();
            warnDuplicate(task);
            continue;
          }
          scheduledJobs[task.job.name] = task.job;
          this.#tasks.set(key, task);
        }
        staged.clear();
      },
    };
  }

  #schedule(owner: HandlerScope, task: TaskDefinition): ScheduledTask {
    const { key, name, cron } = task;
    const job = new Job(() => {
      if (this.#tasks.get(key)?.job !== job || this.#running.has(key) || !this.accepting()) return;

      const completion = Promise.resolve()
        .then(async () => {
          if (this.#tasks.get(key)?.job !== job || !this.accepting()) return;
          if (task.log) console.log($t("lib.plugins.tasks.text_123691cd16", { "name": name }));
          await owner.run(() => task.invoke());
        })
        .catch((error: unknown) => {
          console.warn($t("lib.plugins.tasks.text_da3faae960", { "name": name }), error);
        })
        .finally(() => { this.#running.delete(key); });
      this.#running.set(key, { owner, completion });
    });
    let scheduled = false;
    try {
      scheduled = job.schedule(this.timeZone ? { rule: cron, tz: this.timeZone } : cron);
    } finally {
      if (!scheduled) job.cancel();
    }
    if (!scheduled) throw new Error($t("lib.plugins.tasks.text_dc40fec0a8", { "name": name, "cron": cron }));
    return { name, cron, owner, job };
  }

  #retire(owners?: ReadonlySet<HandlerScope>): void {
    for (const [key, task] of this.#tasks) {
      if (owners && !owners.has(task.owner)) continue;
      this.#tasks.delete(key);
      task.job.cancel();
    }
  }

  stop(): Promise<void> {
    if (!this.#stopping) {
      for (const cancel of this.#preparations) cancel();
      this.#stopping = this.cancel();
    }
    return this.#stopping;
  }

  async cancel(owners?: ReadonlySet<HandlerScope>): Promise<void> {
    this.#retire(owners);
    const pending = [...this.#running.values()].filter(({ owner }) => !owners || owners.has(owner));
    await Promise.all(pending.map(({ completion }) => completion));
  }
}
