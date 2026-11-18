import type { MessageEvent } from "../messages.ts";
import Plugin from "./plugin.js";

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

export class LegacyPlugins {
  readonly #apps: App[] = [];

  constructor() {
    Object.assign(globalThis, { plugin: Plugin });
  }

  register(exports: Record<string, unknown>): boolean {
    const published = exports.apps ?? exports;
    if (typeof published !== "object" || published === null) return false;

    const apps: App[] = [];
    for (const value of new Set(Object.values(published))) {
      if (typeof value !== "function" || !(value.prototype instanceof Plugin)) continue;

      const create = value as PluginClass;
      const app = new create();
      const hasTask = Array.isArray(app.task) ? app.task.length > 0 : Boolean(app.task);
      if (typeof app.init === "function" || app.handler || hasTask) {
        throw new Error(`插件 ${app.name} 需要尚未接入的初始化、Handler 或定时任务接口。`);
      }
      if (!Array.isArray(app.rule) || typeof app.event !== "string" ||
          typeof app.priority !== "number" || !Number.isFinite(app.priority)) {
        throw new Error(`插件 ${app.name} 的事件、优先级或规则无效。`);
      }
      apps.push({ create, rules: rulesFor(app, app.rule), priority: app.priority, event: app.event });
    }

    this.#apps.push(...apps);
    this.#apps.sort((left, right) => left.priority - right.priority);
    return apps.length > 0;
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
