import { HandlerScope } from "./handler.ts";

export type LegacyExitReason = "exit" | "restart";
type Listener = (this: object, reason: LegacyExitReason) => unknown;

export class LegacyExitHooks {
  readonly #registrations = new WeakMap<HandlerScope, Listener[]>();
  readonly #published = new Set<HandlerScope>();
  #exiting?: Promise<boolean>;

  constructor(private readonly timeout = 10_000) {}

  track(scope: HandlerScope) {
    this.#registrations.set(scope, []);
  }

  publish(scope: HandlerScope) {
    this.#published.add(scope);
  }

  discard(scope: HandlerScope) {
    this.#registrations.delete(scope);
    this.#published.delete(scope);
  }

  add(event: unknown, listener: unknown) {
    if (event !== "exit" || this.#exiting) return;
    if (typeof listener !== "function") throw new TypeError("Bot.exit 监听须为函数。");
    const scope = HandlerScope.current();
    if (scope) this.#registrations.get(scope)?.push(listener as Listener);
  }

  remove(event: unknown, listener: unknown) {
    const scope = HandlerScope.current();
    if (event !== "exit" || !scope || typeof listener !== "function") return;
    const listeners = this.#registrations.get(scope);
    const index = listeners?.lastIndexOf(listener as Listener) ?? -1;
    if (index !== -1) listeners?.splice(index, 1);
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
