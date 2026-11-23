import { LegacyExitHooks } from "./exit-hooks.ts";
import { addAbortListener } from "node:events";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { isMilkyOwnerSession } from "../command-permissions.ts";
import { sendCommandReply, type CommandForward } from "../commands.ts";
import common, { isLegacyForward } from "../common/common.js";
import { segment, type BotEvent, type MessageEvent, type MessageReply, type ReplyOptions } from "../messages.ts";
import { legacyTemplateRender } from "../renderer/legacy-template.ts";
import { PluginContexts } from "./contexts.ts";
import Handler, { HandlerScope, UnsupportedLegacyHandlerError, type HandlerCallback } from "./handler.ts";
import { LegacyHttpRoutes } from "./legacy-http.ts";
import Plugin, { PluginCleanup, PluginContext } from "./plugin.js";
import { LegacyTasks } from "./tasks.ts";
import type { NativePluginEvent } from "./native-events.ts";

type PluginInstance = InstanceType<typeof Plugin> & Record<string, unknown>;
type PluginEvent = ReturnType<typeof legacyNotice>;
type PluginClass = new (event?: PluginEvent) => PluginInstance;
const legacyRuntime = Object.freeze({
  common, handler: Object.freeze({ has: Handler.has, call: Handler.call, callAll: Handler.callAll }),
});
const legacyLogger = Object.freeze({
  debug: (...args: unknown[]) => console.debug(...args),
  info: (...args: unknown[]) => console.info(...args),
  mark: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
});

function legacyMessage(event: MessageEvent, legacyMessages: WeakMap<MessageEvent, MessageEvent>,
  resolveTemplates: (plugin: string) => string | undefined): MessageEvent {
  const existing = legacyMessages.get(event);
  if (existing) return existing;
  const reply = event.reply.bind(event);
  const compatibleReply = (message: MessageReply | CommandForward, quote?: boolean, options?: ReplyOptions) => {
    if (!isLegacyForward(message)) return reply(message, quote, options);
    if (!message.nodes.length) return false;
    return sendCommandReply({ reply, forward: event.forward }, message).then(() => true);
  };
  const access = {
    reply: { value: compatibleReply, enumerable: true, configurable: true, writable: true },
    runtime: { value: Object.freeze({ ...legacyRuntime,
      render: legacyTemplateRender({ adapter: event.adapter, reply: compatibleReply }, resolveTemplates) }),
      configurable: true, writable: true },
  };
  const milkyOwner = isMilkyOwnerSession(event);
  const legacy: MessageEvent = milkyOwner || !Object.isExtensible(event) ||
      Object.getOwnPropertyDescriptor(event, "reply")?.configurable === false
    ? Object.create(Object.getPrototypeOf(event), {
      ...Object.getOwnPropertyDescriptors(event),
      ...(milkyOwner && { isMaster: { value: true, enumerable: true, configurable: true, writable: true } }),
      ...access,
    })
    : Object.defineProperties(event, access);
  legacyMessages.set(event, legacy);
  legacyMessages.set(legacy, legacy);
  return legacy;
}
interface Rule {
  readonly reg: RegExp;
  readonly fnc: string;
  readonly event?: string;
  readonly permission?: string;
}

interface App {
  readonly label: string;
  readonly order: number;
  readonly create: PluginClass;
  readonly initializer: PluginInstance;
  readonly scope: HandlerScope;
  readonly contexts: PluginContexts;
  readonly rules: readonly Rule[];
  readonly priority: number;
  readonly event: string;
  readonly names: readonly string[];
  readonly templates?: { readonly name: string; readonly directory: string };
  published: boolean;
}

interface NativeApp {
  readonly order: number;
  readonly native: NativePluginEvent;
  readonly event: string;
  readonly priority: number;
  readonly names: readonly string[];
  readonly contexts: PluginContexts;
  readonly scope: HandlerScope;
  published: boolean;
}

type RoutedApp = App | NativeApp;

function nativeMessage(event: MessageEvent): MessageEvent {
  return Object.create(Object.getPrototypeOf(event), {
    ...Object.getOwnPropertyDescriptors(event),
    reply: { value: event.reply.bind(event), enumerable: true, configurable: true, writable: true },
    isMaster: { value: event.isMaster || isMilkyOwnerSession(event), enumerable: true, configurable: true, writable: true },
  }) as MessageEvent;
}

function legacyNotice(event: BotEvent) {
  if (event.post_type !== "notice" || !("adapter" in event)) return event;
  const milky = event.adapter === "milky";
  // TRSS splits on the first underscore before Bot.em and uses the remainder as the subtype.
  if (event.notice_type === "group_msg_emoji_like") {
    return { ...event, notice_type: "group" as const, sub_type: "msg_emoji_like" as const,
      group_id: milky ? String(event.group_id) : event.group_id,
      user_id: milky ? String(event.user_id) : event.user_id,
      message_id: milky ? String(event.message_id) : event.message_id };
  }
  if (event.notice_type === "group_card") {
    return { ...event, notice_type: "group" as const, sub_type: "card" as const,
      group_id: milky ? String(event.group_id) : event.group_id, user_id: milky ? String(event.user_id) : event.user_id };
  }
  if (event.notice_type === "group_essence") {
    return { ...event, notice_type: "group" as const, sub_type: "essence" as const, action_sub_type: event.sub_type,
      group_id: milky ? String(event.group_id) : event.group_id,
      message_id: milky ? String(event.message_id) : event.message_id,
      operator_id: milky && event.operator_id !== undefined ? String(event.operator_id) : event.operator_id };
  }
  return event;
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

function matches(pattern: string, event: BotEvent | PluginEvent): boolean {
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
  readonly exitHooks = new LegacyExitHooks();
  #apps: App[] = [];
  #ordered: RoutedApp[] = [];
  #nextOrder = 0;
  readonly #nativeApps = new Set<NativeApp>();
  #initializers: App[] = [];
  readonly #messages = new WeakMap<MessageEvent, MessageEvent>();
  readonly #tasks: LegacyTasks;
  readonly #preparing = new Map<string, AbortController>();
  readonly #retiring = new Set<Promise<void>>();
  #disposal?: Promise<void>;

  constructor(private readonly acceptingTasks?: () => boolean) {
    this.#tasks = new LegacyTasks(acceptingTasks);
    Object.assign(globalThis, { plugin: Plugin, segment, logger: legacyLogger });
  }

  register(
    exports: Record<string, unknown>, label: string, packageName = label, signal?: AbortSignal, directory?: string,
  ): Promise<Registration> {
    return this.#install(exports, label, packageName, false, signal, undefined, directory);
  }

  replace(
    exports: Record<string, unknown>, label: string, packageName = label, signal?: AbortSignal,
    validate?: () => Promise<boolean>, directory?: string,
  ): Promise<Registration> {
    return this.#install(exports, label, packageName, true, signal, validate, directory);
  }

  registerNative(events: readonly NativePluginEvent[], label: string, packageName: string): () => Promise<void> {
    const order = this.#nextOrder++;
    const apps = events.map(native => {
      if (typeof native.name !== "string" || typeof native.event !== "string" || !Number.isFinite(native.priority)) {
        throw new Error("原生事件名称、种类或优先级无效。");
      }
      return {
        order, native, event: native.event, priority: native.priority, names: [native.name, label, packageName],
        contexts: new PluginContexts(), scope: new HandlerScope(), published: true,
      };
    });
    for (const app of apps) this.#nativeApps.add(app);
    this.#refreshApps();
    return async () => {
      for (const app of apps) {
        app.published = false;
        app.contexts.close();
        app.scope.dispose();
        this.#nativeApps.delete(app);
      }
      this.#refreshApps();
      await Promise.all(apps.map(app => app.scope.drain()));
    };
  }

  async #install(
    exports: Record<string, unknown>, label: string, packageName: string, replace: boolean,
    externalSignal?: AbortSignal, validate?: () => Promise<boolean>, directory?: string,
  ): Promise<Registration> {
    externalSignal?.throwIfAborted();
    if (this.#disposal) throw new Error("插件加载器已关闭。");

    const transaction = new AbortController();
    const previous = replace ? this.#initializers.filter((app) => app.label === label) : [];
    const oldScopes = new Set(previous.map(({ scope }) => scope));
    const order = previous[0]?.order ?? this.#nextOrder++;
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
      for (const scope of scopes) {
        this.httpRoutes.discard(scope);
        this.exitHooks.discard(scope);
      }
      for (const { initializer, scope } of [...initializers].reverse()) await dispose(initializer, scope);
    };
    const abort = () => {
      for (const scope of scopes) {
        this.httpRoutes.discard(scope);
        this.exitHooks.discard(scope);
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
      const templates = directory ? { name: basename(directory), directory: await realpath(directory) } : undefined;
      for (const value of new Set(Object.values(published))) {
        signal.throwIfAborted();
        if (typeof value !== "function" || !(value.prototype instanceof Plugin)) continue;

        const create = value as PluginClass;
        const scope = new HandlerScope(replace);
        scopes.add(scope);
        this.exitHooks.track(scope);
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
          label, order, create, initializer, scope, contexts: new PluginContexts(), rules: rulesFor(initializer, rule),
          priority, event, names: typeof name === "string" ? [name, label, packageName] : [label, packageName],
          templates, published: false,
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
          this.exitHooks.discard(scope);
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
      for (const app of active) {
        app.published = true;
        this.exitHooks.publish(app.scope);
      }
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
    this.#ordered = [...this.#apps, ...this.#nativeApps]
      .sort((left, right) => left.priority - right.priority || left.order - right.order);
  }

  #retire(apps: readonly App[]): void {
    if (!apps.length) return;
    for (const app of apps) {
      app.published = false;
      app.contexts.close();
      this.httpRoutes.discard(app.scope);
      this.exitHooks.discard(app.scope);
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
    for (const app of this.#ordered) app.contexts.close();
  }

  #message(incoming: MessageEvent): MessageEvent {
    return legacyMessage(incoming, this.#messages, plugin => {
      if (this.#disposal || this.acceptingTasks?.() === false) return;
      const scope = HandlerScope.current();
      if (scope && !this.#apps.some(app => app.published && app.scope === scope)) return;
      return this.#apps.find(app => app.published && app.templates?.name === plugin)?.templates?.directory;
    });
  }

  async dispatchContext(incoming: MessageEvent, allowed?: (names: readonly string[]) => boolean): Promise<boolean> {
    const native = this.#nativeApps.size ? nativeMessage(incoming) : incoming;
    let compatible: MessageEvent | undefined;
    for (const app of this.#ordered) {
      if (!app.published || !app.contexts.active || !matches(app.event, incoming) || (allowed && !allowed(app.names))) continue;
      if ("native" in app) {
        const resume = app.native.continue;
        if (resume && await app.scope.invoke(() => resume(native, app.contexts))) return true;
        continue;
      }
      const event = compatible ??= this.#message(incoming);
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
      this.exitHooks.discard(app.scope);
    }
    const native = [...this.#nativeApps];
    for (const app of native) {
      app.published = false;
      app.contexts.close();
      app.scope.dispose();
    }
    this.#nativeApps.clear();
    this.#initializers = [];
    this.#refreshApps();
    return this.#disposal = (async () => {
      await Promise.all(native.map(app => app.scope.drain()));
      await this.stopTasks();
      this.#retire(apps);
      await Promise.all(this.#retiring);
    })();
  }

  async dispatch(incoming: BotEvent, allowed?: (names: readonly string[]) => boolean, onDenied?: () => void): Promise<boolean> {
    try {
      return await this.#dispatch(incoming, allowed, onDenied);
    } catch (error) {
      if (!(error instanceof UnsupportedLegacyHandlerError)) throw error;
      console.error(error.message);
      if (incoming.post_type === "message") await incoming.reply(error.message);
      return true;
    }
  }

  async #dispatch(incoming: BotEvent, allowed?: (names: readonly string[]) => boolean, onDenied?: () => void): Promise<boolean> {
    const legacyEvent = legacyNotice(incoming);
    const matching = this.#ordered.filter((app) => matches(app.event, "native" in app ? incoming : legacyEvent) &&
      (!allowed || allowed(app.names)));
    const native = incoming.post_type === "message" && matching.some(app => "native" in app) ? nativeMessage(incoming) : incoming;
    let legacy: PluginEvent | undefined;
    const compatible = () => legacy ??= incoming.post_type === "message" ? this.#message(incoming) : legacyEvent;
    for (const app of matching) {
      if (!app.published) continue;
      let result: unknown;
      if ("native" in app) {
        const observe = app.native.observe;
        if (observe) result = await app.scope.invoke(() => observe(native));
      } else if (typeof app.initializer.accept === "function") {
        result = await app.scope.invoke(() => {
          const event = compatible();
          const instance = Object.assign(new app.create(event), { e: event, [PluginContext]: app.contexts });
          return typeof instance.accept === "function" ? instance.accept(event) : undefined;
        });
      }
      if (result === "return") return true;
      if (result) break;
    }

    for (const app of matching) {
      if ("native" in app) {
        const rule = app.native.rule;
        if (!app.published || !rule || native.post_type !== "message") continue;
        rule.pattern.lastIndex = 0;
        if (!rule.pattern.test(native.msg)) continue;
        if (!canRun(rule.permission, native)) {
          if (native.isDelegated) onDenied?.();
          else native.reply("暂无权限执行此指令。");
          return true;
        }
        if (await app.scope.invoke(() => rule.run(native, app.contexts)) !== false) return true;
        continue;
      }
      const event = compatible();
      for (const rule of app.rules) {
        if (!app.published) break;
        if (rule.event && !matches(rule.event, event)) continue;
        rule.reg.lastIndex = 0;
        if (!rule.reg.test(event.post_type === "message" ? event.msg : "")) continue;
        if (!canRun(rule.permission, event)) {
          if (event.post_type === "message" && event.isDelegated) onDenied?.();
          else event.reply("暂无权限执行此指令。");
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
