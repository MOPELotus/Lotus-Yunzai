import { AsyncLocalStorage } from "node:async_hooks";

export type HandlerCallback = (event: unknown, args: unknown, next: (reason?: string) => void) => unknown;

interface Registration {
  readonly key?: string;
  readonly event?: string;
  readonly ns?: string;
  readonly fn: HandlerCallback;
  readonly self?: unknown;
  readonly priority?: number;
}

interface Entry {
  readonly owner: HandlerScope;
  readonly ns?: string;
  readonly fn: HandlerCallback;
  readonly self?: unknown;
  readonly priority: number;
}

const scopes = new AsyncLocalStorage<HandlerScope>();
const handlers = new Map<string, Entry[]>();

export class HandlerScope {
  #active = true;

  run<T>(fn: () => T): T {
    return scopes.run(this, fn);
  }

  add(config: Registration): void {
    const key = config.key || config.event;
    if (!this.#active || typeof key !== "string" || !key.trim() || typeof config.fn !== "function") return;
    if (key.trim().toLowerCase() === "mys.req.err") {
      console.warn("[Handler] mys.req.err 由内置服务保留，忽略插件注册。");
      return;
    }

    this.del(config.ns, key);
    const entries = handlers.get(key) ?? [];
    entries.push({
      owner: this,
      fn: config.fn,
      self: config.self,
      ns: config.ns,
      priority: typeof config.priority === "number" && Number.isFinite(config.priority) ? config.priority : 500,
    });
    entries.sort((left, right) => left.priority - right.priority);
    handlers.set(key, entries);
  }

  del(ns?: string, key?: string): void {
    for (const name of key ? [key] : handlers.keys()) {
      const remaining = handlers.get(name)?.filter((entry) => entry.owner !== this || entry.ns !== ns);
      if (remaining?.length) handlers.set(name, remaining);
      else handlers.delete(name);
    }
  }

  dispose(): void {
    this.#active = false;
    for (const [key, entries] of handlers) {
      const remaining = entries.filter((entry) => entry.owner !== this);
      if (remaining.length) handlers.set(key, remaining);
      else handlers.delete(key);
    }
  }
}

const Handler = {
  add(config: Registration): void {
    const scope = scopes.getStore();
    if (!scope) throw new Error("Handler.add 须在插件执行期间调用。");
    scope.add(config);
  },
  del(ns?: string, key?: string): void {
    scopes.getStore()?.del(ns, key);
  },
  has(key: string): boolean {
    return handlers.has(key);
  },
  async call(key: string, event?: unknown, args?: unknown, all = false): Promise<unknown> {
    let result: unknown;
    for (const entry of [...(handlers.get(key) ?? [])]) {
      if (!handlers.get(key)?.includes(entry)) continue;
      let next = false;
      result = await entry.owner.run(() => entry.fn.call(entry.self, event, args, () => { next = true; }));
      if (!next && !all) return result;
    }
    return result;
  },
  callAll(key: string, event?: unknown, args?: unknown): Promise<unknown> {
    return Handler.call(key, event, args, true);
  },
};

export default Handler;
