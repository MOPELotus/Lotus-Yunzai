import { segment, type MessageEvent } from "../messages.ts";
import Plugin, { PluginCleanup } from "./plugin.js";

type PluginInstance = InstanceType<typeof Plugin> & Record<string, unknown>;
type PluginClass = new (event?: MessageEvent) => PluginInstance;
interface Rule {
  readonly reg: RegExp;
  readonly fnc: string;
  readonly event?: string;
  readonly permission?: string;
}

interface App {
  readonly create: PluginClass;
  readonly initializer: PluginInstance;
  readonly rules: readonly Rule[];
  readonly priority: number;
  readonly event: string;
}

function rulesFor(app: PluginInstance, rules: readonly unknown[]): Rule[] {
  return rules.map((value) => {
    const rule = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    if ((typeof rule.reg !== "string" && !(rule.reg instanceof RegExp)) ||
        typeof rule.fnc !== "string" || typeof app[rule.fnc] !== "function" ||
        (rule.event !== undefined && typeof rule.event !== "string") ||
        (rule.permission !== undefined && typeof rule.permission !== "string")) {
      throw new Error(`插件 ${app.name} 有无效的消息规则。`);
    }
    return { reg: new RegExp(rule.reg), fnc: rule.fnc, event: rule.event, permission: rule.permission };
  });
}

function matches(pattern: string, event: MessageEvent): boolean {
  const parts = [event.post_type, event.message_type, event.sub_type];
  return pattern.split(".").every((value, index) =>
    parts[index] !== undefined && (value === "*" || value === parts[index]));
}

function canRun(permission: string | undefined, event: MessageEvent): boolean {
  if (!permission || permission === "all" || event.isMaster) return true;
  if (permission === "owner") return event.member?.is_owner === true;
  if (permission === "admin") return event.member?.is_owner === true || event.member?.is_admin === true;
  return false;
}

async function dispose(app: PluginInstance): Promise<void> {
  for (const cleanup of app[PluginCleanup].splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      console.warn(`[插件] 清理 ${app.name} 失败：`, error);
    }
  }
}

export class LegacyPlugins {
  readonly #apps: App[] = [];
  readonly #initializers: PluginInstance[] = [];

  constructor() {
    Object.assign(globalThis, { plugin: Plugin, segment });
  }

  async register(exports: Record<string, unknown>): Promise<"loaded" | "skipped" | "empty"> {
    const published = exports.apps ?? exports;
    if (typeof published !== "object" || published === null) return "empty";

    const initializers: PluginInstance[] = [];
    const staged: App[] = [];
    const active: App[] = [];
    try {
      for (const value of new Set(Object.values(published))) {
        if (typeof value !== "function" || !(value.prototype instanceof Plugin)) continue;

        const create = value as PluginClass;
        const initializer = new create();
        initializers.push(initializer);
        const { task, handler, rule, event, priority } = initializer;
        const hasTask = Array.isArray(task) ? task.length > 0 : Boolean(task);
        if (handler || hasTask) {
          throw new Error(`插件 ${initializer.name} 需要尚未接入的 Handler 或定时任务接口。`);
        }
        if (!Array.isArray(rule) || typeof event !== "string" ||
            typeof priority !== "number" || !Number.isFinite(priority)) {
          throw new Error(`插件 ${initializer.name} 的事件、优先级或规则无效。`);
        }
        staged.push({ create, initializer, rules: rulesFor(initializer, rule), priority, event });
      }

      for (const app of staged) {
        const initializer = app.initializer;
        if (typeof initializer.init === "function" && await initializer.init() === "return") {
          await dispose(initializer);
        } else {
          active.push(app);
        }
      }
    } catch (error) {
      for (const initializer of initializers.reverse()) await dispose(initializer);
      throw error;
    }

    this.#initializers.push(...active.map(({ initializer }) => initializer));
    this.#apps.push(...active);
    this.#apps.sort((left, right) => left.priority - right.priority);
    return active.length > 0 ? "loaded" : staged.length > 0 ? "skipped" : "empty";
  }

  async dispose(): Promise<void> {
    this.#apps.length = 0;
    for (const initializer of this.#initializers.splice(0).reverse()) await dispose(initializer);
  }

  async dispatch(event: MessageEvent): Promise<void> {
    for (const app of this.#apps) {
      if (!matches(app.event, event)) continue;

      for (const rule of app.rules) {
        if (rule.event && !matches(rule.event, event)) continue;
        rule.reg.lastIndex = 0;
        if (!rule.reg.test(event.msg)) continue;
        if (!canRun(rule.permission, event)) {
          event.reply("暂无权限执行此指令。");
          return;
        }

        const instance = Object.assign(new app.create(event), { e: event });
        const handle = instance[rule.fnc];
        if (typeof handle === "function" && await handle.call(instance, event) !== false) return;
      }
    }
  }
}
