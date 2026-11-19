import { addAbortListener } from "node:events";
import { isMilkyOwnerSession } from "../command-permissions.ts";
import { segment, type BotEvent, type MessageEvent } from "../messages.ts";
import { PluginContexts } from "./contexts.ts";
import { HandlerScope, type HandlerCallback } from "./handler.ts";
import { LegacyHttpRoutes } from "./legacy-http.ts";
import Plugin, { PluginCleanup, PluginContext } from "./plugin.js";
import { LegacyTasks } from "./tasks.ts";

type PluginInstance = InstanceType<typeof Plugin> & Record<string, unknown>;
type PluginEvent = BotEvent;
type PluginClass = new (event?: PluginEvent) => PluginInstance;

function legacyMessage(event: MessageEvent): MessageEvent {
  if (!isMilkyOwnerSession(event)) return event;
  // Preserve the game accessors used by V3 rules while projecting the owner flag.
  return Object.create(Object.getPrototypeOf(event), {
    ...Object.getOwnPropertyDescriptors(event),
    isMaster: { value: true, enumerable: true, configurable: true, writable: true },
  });
}
interface Rule {
  readonly reg: RegExp;
  readonly fnc: string;
  readonly event?: string;
  readonly permission?: string;
}

interface App {
  readonly label: string;
  readonly create: PluginClass;
  readonly initializer: PluginInstance;
  readonly scope: HandlerScope;
  readonly contexts: PluginContexts;
  readonly rules: readonly Rule[];
  readonly priority: number;
  readonly event: string;
  readonly names: readonly string[];
  published: boolean;
}

type Registration = "loaded" | "skipped" | "empty";

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
  readonly httpRoutes = new LegacyHttpRoutes();
  #apps: App[] = [];
  #initializers: App[] = [];
  readonly #tasks: LegacyTasks;
  readonly #preparing = new Map<string, AbortController>();
  readonly #retiring = new Set<Promise<void>>();
  #disposal?: Promise<void>;

  constructor(acceptingTasks?: () => boolean) {
    this.#tasks = new LegacyTasks(acceptingTasks);
    Object.assign(globalThis, { plugin: Plugin, segment });
  }

  register(
    exports: Record<string, unknown>, label: string, packageName = label, signal?: AbortSignal,
  ): Promise<Registration> {
    return this.#install(exports, label, packageName, false, signal);
  }

  replace(
    exports: Record<string, unknown>, label: string, packageName = label, signal?: AbortSignal,
    validate?: () => Promise<boolean>,
  ): Promise<Registration> {
    return this.#install(exports, label, packageName, true, signal, validate);
  }

  async #install(
    exports: Record<string, unknown>, label: string, packageName: string, replace: boolean,
    externalSignal?: AbortSignal, validate?: () => Promise<boolean>,
  ): Promise<Registration> {
    externalSignal?.throwIfAborted();
    if (this.#disposal) throw new Error("插件加载器已关闭。");

    const transaction = new AbortController();
    const previous = replace ? this.#initializers.filter((app) => app.label === label) : [];
    const oldScopes = new Set(previous.map(({ scope }) => scope));
    this.#preparing.get(label)?.abort(new Error("插件入口有更新的加载请求。"));
    this.#preparing.set(label, transaction);
    const signal = externalSignal ? AbortSignal.any([externalSignal, transaction.signal]) : transaction.signal;

    const scopes = new Set<HandlerScope>();
    const initializers: { initializer: PluginInstance; scope: HandlerScope }[] = [];
    const staged: App[] = [];
    const active: App[] = [];
    let jobs: ReturnType<LegacyTasks["prepare"]> | undefined;
    let abortCleanup: Promise<void> | undefined;

    const rollback = async () => {
      jobs?.cancel();
      for (const scope of scopes) this.httpRoutes.discard(scope);
      for (const { initializer, scope } of [...initializers].reverse()) await dispose(initializer, scope);
    };
    const abort = () => {
      for (const scope of scopes) {
        this.httpRoutes.discard(scope);
        scope.dispose();
      }
      abortCleanup = Promise.resolve().then(rollback).catch((error: unknown) => {
        console.warn(`[插件] 清理 ${label} 失败：`, error);
      });
    };

    const abortListener = addAbortListener(signal, abort);
    try {
      const published = exports.apps ?? exports;
      if (typeof published !== "object" || published === null) return "empty";
      for (const value of new Set(Object.values(published))) {
        signal.throwIfAborted();
        if (typeof value !== "function" || !(value.prototype instanceof Plugin)) continue;

        const create = value as PluginClass;
        const scope = new HandlerScope(replace);
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
          label, create, initializer, scope, contexts: new PluginContexts(), rules: rulesFor(initializer, rule),
          priority, event, names: typeof name === "string" ? [name, label, packageName] : [label, packageName],
          published: false,
        });
      }

      for (const app of staged) {
        signal.throwIfAborted();
        const { initializer, scope } = app;
        const init = initializer.init;
        let result: unknown;
        if (typeof init === "function") {
          this.httpRoutes.open(scope);
          try {
            result = await scope.run(() => init.call(initializer));
          } finally {
            this.httpRoutes.seal(scope);
          }
        }
        signal.throwIfAborted();
        if (result === "return") {
          this.httpRoutes.discard(scope);
          await dispose(initializer, scope);
        } else {
          registerHandlers(app, label);
          active.push(app);
        }
      }
      signal.throwIfAborted();
      if (!active.length) return staged.length ? "skipped" : "empty";

      jobs = this.#tasks.prepare(active.map(({ initializer, scope }) => ({ app: initializer, owner: scope })), oldScopes);
      if (validate && !await validate()) {
        signal.throwIfAborted();
        await rollback();
        signal.throwIfAborted();
        return "skipped";
      }
      signal.throwIfAborted();
      const routes = this.httpRoutes.prepare(active.map(({ scope }) => scope), oldScopes);
      jobs.publish();
      if (replace) active.forEach((app, index) => app.scope.publish(previous[index]?.scope));
      routes.publish();
      for (const app of active) app.published = true;
      const index = previous.length ? this.#initializers.indexOf(previous[0]!) : this.#initializers.length;
      if (previous.length) this.#initializers = this.#initializers.filter((app) => app.label !== label);
      this.#initializers.splice(index, 0, ...active);
      this.#refreshApps();
      this.#retire(previous);
      return "loaded";
    } catch (error) {
      if (abortCleanup) await abortCleanup;
      // Initializers can add cleanup callbacks while a cancelled init is still settling.
      await rollback();
      throw signal.aborted ? signal.reason : error;
    } finally {
      abortListener[Symbol.dispose]();
      if (this.#preparing.get(label) === transaction) this.#preparing.delete(label);
    }
  }

  #refreshApps(): void {
    this.#apps = [...this.#initializers].sort((left, right) => left.priority - right.priority);
  }

  #retire(apps: readonly App[]): void {
    if (!apps.length) return;
    for (const app of apps) {
      app.published = false;
      app.contexts.close();
      this.httpRoutes.discard(app.scope);
      app.scope.dispose();
    }
    const tasks = this.#tasks.cancel(new Set(apps.map(({ scope }) => scope)));
    const settled = Promise.allSettled([tasks, ...apps.map(({ scope }) => scope.drain())]);
    const cleanup = settled.then(async () => {
      for (const { initializer, scope } of [...apps].reverse()) await dispose(initializer, scope);
    });
    this.#retiring.add(cleanup);
    void cleanup.then(() => this.#retiring.delete(cleanup), (error: unknown) => {
      this.#retiring.delete(cleanup);
      console.warn("[插件] 清理已撤销的入口失败：", error);
    });
  }

  async remove(label: string): Promise<void> {
    this.#preparing.get(label)?.abort(new Error("插件入口已撤销。"));
    const previous = this.#initializers.filter((app) => app.label === label);
    if (!previous.length) return;
    this.#initializers = this.#initializers.filter((app) => app.label !== label);
    this.#refreshApps();
    this.#retire(previous);
  }

  stopContexts(): void {
    for (const app of this.#apps) app.contexts.close();
  }

  async dispatchContext(incoming: MessageEvent, allowed?: (names: readonly string[]) => boolean): Promise<boolean> {
    const event = legacyMessage(incoming);
    for (const app of this.#apps) {
      if (!app.published || !app.contexts.active || !matches(app.event, event) || (allowed && !allowed(app.names))) continue;
      if (app.contexts.resolve(event)) return true;
      const contexts = { ...app.contexts.get(event, false), ...app.contexts.get(event, true) };
      if (!Object.keys(contexts).length) continue;

      const result = await app.scope.invoke(async () => {
        let result: unknown;
        for (const [method, origin] of Object.entries(contexts)) {
          if (!app.published) return "continue";
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

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    for (const transaction of this.#preparing.values()) transaction.abort(new Error("插件加载器已关闭。"));
    const apps = this.#initializers;
    for (const app of apps) {
      app.published = false;
      app.contexts.close();
      this.httpRoutes.discard(app.scope);
    }
    this.#initializers = [];
    this.#apps = [];
    return this.#disposal = (async () => {
      await this.stopTasks();
      this.#retire(apps);
      await Promise.all(this.#retiring);
    })();
  }

  async dispatch(incoming: PluginEvent, allowed?: (names: readonly string[]) => boolean): Promise<boolean> {
    const event = incoming.post_type === "message" ? legacyMessage(incoming) : incoming;
    const matching = this.#apps.filter((app) => matches(app.event, event) && (!allowed || allowed(app.names)));
    for (const app of matching) {
      if (!app.published || typeof app.initializer.accept !== "function") continue;
      const result = await app.scope.invoke(() => {
        const instance = Object.assign(new app.create(event), { e: event, [PluginContext]: app.contexts });
        return typeof instance.accept === "function" ? instance.accept(event) : undefined;
      });
      if (result === "return") return true;
      if (result) break;
    }

    for (const app of matching) {
      for (const rule of app.rules) {
        if (!app.published) break;
        if (rule.event && !matches(rule.event, event)) continue;
        rule.reg.lastIndex = 0;
        if (!rule.reg.test(event.post_type === "message" ? event.msg : "")) continue;
        if (!canRun(rule.permission, event)) {
          event.reply("暂无权限执行此指令。");
          return true;
        }

        const result = await app.scope.invoke(() => {
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
