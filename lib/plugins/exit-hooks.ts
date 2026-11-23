import type { OneBotLegacySignal } from "../messages.ts";
import { HandlerScope } from "./handler.ts";

export type LegacyExitReason = "exit" | "restart";
type Listener = (this: object, reason: LegacyExitReason) => unknown;
type LiveListener = (this: object, event: OneBotLegacySignal) => unknown;
type LiveBinding = { name: string; fn: LiveListener; once: boolean };
const legacySignalNames = new Set([
  "internal", "internal.input", "internal.input.input_status",
  "system", "system.offline", "system.offline.undefined",
]);

export class LegacyExitHooks {
  readonly #registrations = new WeakMap<HandlerScope, Listener[]>();
  readonly #live = new WeakMap<HandlerScope, LiveBinding[]>();
  readonly #published = new Set<HandlerScope>();
  #exiting?: Promise<boolean>;

  constructor(private readonly timeout = 10_000) {}

  track(scope: HandlerScope) {
    this.#registrations.set(scope, []);
    this.#live.set(scope, []);
  }

  publish(scope: HandlerScope) {
    this.#published.add(scope);
  }

  discard(scope: HandlerScope) {
    this.#registrations.delete(scope);
    this.#live.delete(scope);
    this.#published.delete(scope);
  }

  add(event: unknown, listener: unknown, once = false) {
    if (this.#exiting) return;
    if (event === "exit") {
      if (typeof listener !== "function") throw new TypeError("Bot.exit 监听须为函数。");
      const scope = HandlerScope.current();
      if (scope) this.#registrations.get(scope)?.push(listener as Listener);
    } else if (typeof event === "string" && legacySignalNames.has(event)) {
      if (typeof listener !== "function") throw new TypeError("Bot 事件监听须为函数。");
      const scope = HandlerScope.current();
      if (scope) this.#live.get(scope)?.push({ name: event, fn: listener as LiveListener, once });
    }
  }

  remove(event: unknown, listener: unknown) {
    const scope = HandlerScope.current();
    if (!scope || typeof listener !== "function") return;
    if (event === "exit") {
      const listeners = this.#registrations.get(scope);
      const index = listeners?.lastIndexOf(listener as Listener) ?? -1;
      if (index !== -1) listeners?.splice(index, 1);
    } else {
      const listeners = this.#live.get(scope);
      const index = listeners?.findLastIndex(binding => binding.name === event && binding.fn === listener) ?? -1;
      if (index !== -1) listeners?.splice(index, 1);
    }
  }

  emit(bot: object, event: OneBotLegacySignal, signal: AbortSignal) {
    const category = `${event.post_type}.${event.notice_type}`;
    for (const name of [`${category}.${event.sub_type}`, category, event.post_type]) {
      for (const scope of this.#published) {
        const listeners = this.#live.get(scope);
        for (const binding of [...listeners ?? []]) {
          if (signal.aborted) return;
          if (binding.name !== name || this.#live.get(scope) !== listeners || !listeners?.includes(binding)) continue;
          if (binding.once) listeners.splice(listeners.indexOf(binding), 1);
          void scope.invoke(() => binding.fn.call(bot, event)).catch(() => console.warn("[插件] V3 通知回调执行失败。"));
        }
      }
    }
  }

  run(bot: object, reason: LegacyExitReason): Promise<boolean> {
    if (this.#exiting) return this.#exiting;

    const listeners = [...this.#published].flatMap(scope =>
      [...this.#registrations.get(scope) ?? []].map(listener => ({ scope, listener })));
    for (const scope of this.#published) this.discard(scope);
    return this.#exiting = Promise.resolve().then(async () => {
      if (listeners.length === 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(listeners.map(({ scope, listener }) => Promise.resolve().then(() => {
            return scope.run(() => listener.call(bot, reason));
          }).catch(() => console.warn("[插件] V3 退出回调执行失败。")))),
          new Promise<void>(resolve => {
            timer = setTimeout(() => {
              console.warn("[插件] 等待 V3 退出回调超时。");
              resolve();
            }, this.timeout);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      return true;
    });
  }
}
