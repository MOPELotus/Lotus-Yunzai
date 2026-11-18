import { addAbortListener } from "node:events";
import { segment, type BotEvent, type MessageEvent } from "../messages.ts";
import { PluginContexts } from "./contexts.ts";
import { HandlerScope, type HandlerCallback } from "./handler.ts";
import Plugin, { PluginCleanup, PluginContext } from "./plugin.js";
import { LegacyTasks } from "./tasks.ts";

type PluginInstance = InstanceType<typeof Plugin> & Record<string, unknown>;
type PluginEvent = BotEvent;
type PluginClass = new (event?: PluginEvent) => PluginInstance;
interface Rule {
  readonly reg: RegExp;
  readonly fnc: string;
  readonly event?: string;
  readonly permission?: string;
}

interface App {
  readonly create: PluginClass;
  readonly initializer: PluginInstance;
  readonly scope: HandlerScope;
  readonly contexts: PluginContexts;
  readonly rules: readonly Rule[];
  readonly priority: number;
  readonly event: string;
  readonly names: readonly string[];
}

function rulesFor(app: PluginInstance, rules: readonly unknown[]): Rule[] {
  return rules.map((value) => {
    const rule = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    if ((rule.reg !== undefined && typeof rule.reg !== "string" && !(rule.reg instanceof RegExp)) ||
        typeof rule.fnc !== "string" || typeof app[rule.fnc] !== "function" ||
        (rule.event !== undefined && typeof rule.event !== "string") ||
        (rule.permission !== undefined && typeof rule.permission !== "string")) {
      throw new Error(`插件 ${app.name} 有无效的消息规则。`);
    }
    return { reg: new RegExp(rule.reg ?? ""), fnc: rule.fnc, event: rule.event, permission: rule.permission };
  });
}

function matches(pattern: string, event: PluginEvent): boolean {
  const subtype = event.post_type === "message" ? event.message_type
    : event.post_type === "notice" ? event.notice_type : event.request_type;
  const parts = [event.post_type, subtype, event.sub_type];
  return pattern.split(".").every((value, index) =>
    parts[index] !== undefined && (value === "*" || value === parts[index]));
}

function canRun(permission: string | undefined, event: PluginEvent): boolean {
  if (!permission || permission === "all" || event.isMaster) return true;
  if (event.post_type !== "message") return false;
  if (permission === "owner") return event.member?.is_owner === true;
  if (permission === "admin") return event.member?.is_owner === true || event.member?.is_admin === true;
  return false;
}

function registerHandlers(app: App, label: string): void {
  const { initializer, scope } = app;
  const configured = initializer.handler;
  if (configured === undefined || configured === null) return;
  if (typeof configured !== "object") throw new Error(`插件 ${initializer.name} 的 Handler 格式无效。`);

  const ns = typeof initializer.namespace === "string" && initializer.namespace ? initializer.namespace : label;
  for (const value of Object.values(configured)) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`插件 ${initializer.name} 的 Handler 格式无效。`);
    }
    const { key, fn, priority } = value as Record<string, unknown>;
    const method = typeof fn === "string" ? initializer[fn] : undefined;
    if (typeof key !== "string" || !key.trim() || typeof method !== "function" ||
        (priority !== undefined && (typeof priority !== "number" || !Number.isFinite(priority)))) {
      throw new Error(`插件 ${initializer.name} 的 Handler 键、方法或优先级无效。`);
    }
    scope.add({ key, ns, fn: method as HandlerCallback,
      self: initializer, priority: priority ?? app.priority });
  }
}

async function dispose(app: PluginInstance, scope: HandlerScope): Promise<void> {
  scope.dispose();
  for (const cleanup of app[PluginCleanup].splice(0).reverse()) {
    try {
      await scope.run(cleanup);
    } catch (error) {
      console.warn(`[插件] 清理 ${app.name} 失败：`, error);
    }
  }
}

export class LegacyPlugins {
  readonly #apps: App[] = [];
  readonly #initializers: App[] = [];
  readonly #tasks: LegacyTasks;

  constructor(acceptingTasks?: () => boolean) {
    this.#tasks = new LegacyTasks(acceptingTasks);
    Object.assign(globalThis, { plugin: Plugin, segment });
  }

  async register(
    exports: Record<string, unknown>, label: string, packageName = label, signal?: AbortSignal,
  ): Promise<"loaded" | "skipped" | "empty"> {
    signal?.throwIfAborted();
    const published = exports.apps ?? exports;
    if (typeof published !== "object" || published === null) return "empty";

    const scopes = new Set<HandlerScope>();
    const initializers: { initializer: PluginInstance; scope: HandlerScope }[] = [];
    const staged: App[] = [];
    const active: App[] = [];
    let abortCleanup: Promise<void> | undefined;

    const rollback = async () => {
      await this.#tasks.cancel(scopes);
      for (const { initializer, scope } of [...initializers].reverse()) await dispose(initializer, scope);
    };
    const abort = () => {
      for (const scope of scopes) scope.dispose();
      abortCleanup = Promise.resolve().then(rollback).catch((error: unknown) => {
        console.warn(`[插件] 清理 ${label} 失败：`, error);
      });
    };

    const abortListener = signal && addAbortListener(signal, abort);
    try {
      for (const value of new Set(Object.values(published))) {
        signal?.throwIfAborted();
        if (typeof value !== "function" || !(value.prototype instanceof Plugin)) continue;

        const create = value as PluginClass;
        const scope = new HandlerScope();
        scopes.add(scope);
        let initializer: PluginInstance;
        try {
          initializer = scope.run(() => new create());
        } catch (error) {
          scope.dispose();
          throw error;
        }
        initializers.push({ initializer, scope });
        const { rule, event, priority, name } = initializer;
        if (!Array.isArray(rule) || typeof event !== "string" ||
            typeof priority !== "number" || !Number.isFinite(priority)) {
          throw new Error(`插件 ${initializer.name} 的事件、优先级或规则无效。`);
        }
        staged.push({
          create, initializer, scope, contexts: new PluginContexts(), rules: rulesFor(initializer, rule),
          priority, event, names: typeof name === "string" ? [name, label, packageName] : [label, packageName],
        });
      }

      for (const app of staged) {
        signal?.throwIfAborted();
        const { initializer, scope } = app;
        const init = initializer.init;
        const result = typeof init === "function" ? await scope.run(() => init.call(initializer)) : undefined;
        signal?.throwIfAborted();
        if (result === "return") {
          await dispose(initializer, scope);
        } else {
          registerHandlers(app, label);
          active.push(app);
        }
      }
      for (const { initializer, scope } of active) {
        signal?.throwIfAborted();
        this.#tasks.register(scope, initializer);
      }
      signal?.throwIfAborted();
    } catch (error) {
      if (abortCleanup) await abortCleanup;
      // Initializers can add cleanup callbacks while a cancelled init is still settling.
      await rollback();
      throw signal?.aborted ? signal.reason : error;
    } finally {
      abortListener?.[Symbol.dispose]();
    }

    this.#initializers.push(...active);
    this.#apps.push(...active);
    this.#apps.sort((left, right) => left.priority - right.priority);
    return active.length > 0 ? "loaded" : staged.length > 0 ? "skipped" : "empty";
  }

  stopContexts(): void {
    for (const app of this.#apps) app.contexts.close();
  }

  async dispatchContext(event: MessageEvent, allowed?: (names: readonly string[]) => boolean): Promise<boolean> {
    for (const app of this.#apps) {
      if (!app.contexts.active || !matches(app.event, event) || (allowed && !allowed(app.names))) continue;
      if (app.contexts.resolve(event)) return true;
      const contexts = { ...app.contexts.get(event, false), ...app.contexts.get(event, true) };
      if (!Object.keys(contexts).length) continue;

      const result = await app.scope.run(async () => {
        let result: unknown;
        for (const [method, origin] of Object.entries(contexts)) {
          const instance = Object.assign(new app.create(event), { e: event, [PluginContext]: app.contexts });
          const handler = instance[method];
          if (typeof handler === "function") result = await handler.call(instance, origin);
          if (result) break;
        }
        return result;
      });
      if (result !== "continue") return true;
    }
    return false;
  }

  stopTasks(): Promise<void> {
    return this.#tasks.stop();
  }

  async dispose(): Promise<void> {
    this.stopContexts();
    this.#apps.length = 0;
    await this.stopTasks();
    for (const { initializer, scope } of this.#initializers.splice(0).reverse()) {
      await dispose(initializer, scope);
    }
  }

  async dispatch(event: PluginEvent, allowed?: (names: readonly string[]) => boolean): Promise<boolean> {
    const matching = this.#apps.filter((app) => matches(app.event, event) && (!allowed || allowed(app.names)));
    for (const app of matching) {
      if (typeof app.initializer.accept !== "function") continue;
      const result = await app.scope.run(() => {
        const instance = Object.assign(new app.create(event), { e: event, [PluginContext]: app.contexts });
        return typeof instance.accept === "function" ? instance.accept(event) : undefined;
      });
      if (result === "return") return true;
      if (result) break;
    }

    for (const app of matching) {
      for (const rule of app.rules) {
        if (rule.event && !matches(rule.event, event)) continue;
        rule.reg.lastIndex = 0;
        if (!rule.reg.test(event.post_type === "message" ? event.msg : "")) continue;
        if (!canRun(rule.permission, event)) {
          event.reply("暂无权限执行此指令。");
          return true;
        }

        const result = await app.scope.run(() => {
          const instance = Object.assign(new app.create(event), { e: event, [PluginContext]: app.contexts });
          const handle = instance[rule.fnc];
          return typeof handle === "function" ? handle.call(instance, event) : false;
        });
        if (result !== false) return true;
      }
    }
    return false;
  }
}
