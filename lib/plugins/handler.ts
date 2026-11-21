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

export class UnsupportedLegacyHandlerError extends Error {
  constructor() {
    super("旧接口 mys.req.err 不受支持，插件需要适配 Lotus Yunzai 才能使用。");
    this.name = "UnsupportedLegacyHandlerError";
  }
}

function requireSupportedHandler(key: string): void {
  if (typeof key === "string" && key.trim().toLowerCase() === "mys.req.err") {
    throw new UnsupportedLegacyHandlerError();
  }
}

function insert(registry: Map<string, Entry[]>, key: string, entry: Entry, replacing?: HandlerScope): void {
  const entries = registry.get(key) ?? [];
  const previous = replacing === undefined ? -1 : entries.findIndex((candidate) =>
    candidate.owner === replacing && candidate.ns === entry.ns && candidate.priority === entry.priority);
  if (previous === -1) entries.push(entry);
  else entries.splice(previous, 0, entry);
  entries.sort((left, right) => left.priority - right.priority);
  registry.set(key, entries);
}

export class HandlerScope {
  #active = true;
  #staged?: Map<string, Entry[]>;
  readonly #running = new Set<Promise<void>>();

  static current(): HandlerScope | undefined {
    return scopes.getStore();
  }

  constructor(staged = false) {
    if (staged) this.#staged = new Map();
  }

  run<T>(fn: () => T): T {
    return scopes.run(this, fn);
  }

  async invoke<T>(fn: () => T): Promise<Awaited<T>> {
    const finished = Promise.withResolvers<void>();
    this.#running.add(finished.promise);
    try {
      return await this.run(fn);
    } finally {
      this.#running.delete(finished.promise);
      finished.resolve();
    }
  }

  add(config: Registration): void {
    const key = config.key || config.event;
    if (!this.#active || typeof key !== "string" || !key.trim() || typeof config.fn !== "function") return;
    requireSupportedHandler(key);

    this.del(config.ns, key);
    insert(this.#staged ?? handlers, key, {
      owner: this,
      fn: config.fn,
      self: config.self,
      ns: config.ns,
      priority: typeof config.priority === "number" && Number.isFinite(config.priority) ? config.priority : 500,
    });
  }

  del(ns?: string, key?: string): void {
    const registry = this.#staged ?? handlers;
    for (const name of key ? [key] : registry.keys()) {
      const remaining = registry.get(name)?.filter((entry) => entry.owner !== this || entry.ns !== ns);
      if (remaining?.length) registry.set(name, remaining);
      else registry.delete(name);
    }
  }

  publish(replacing?: HandlerScope): void {
    if (!this.#active || !this.#staged) return;
    // The caller retires the old scope in this same turn, after its entries provide the insertion positions.
    for (const [key, entries] of this.#staged) {
      for (const entry of entries) insert(handlers, key, entry, replacing);
    }
    this.#staged = undefined;
  }

  dispose(): void {
    if (!this.#active) return;
    this.#active = false;
    if (this.#staged) {
      this.#staged.clear();
      return;
    }
    for (const [key, entries] of handlers) {
      const remaining = entries.filter((entry) => entry.owner !== this);
      if (remaining.length) handlers.set(key, remaining);
      else handlers.delete(key);
    }
  }

  async drain(): Promise<void> {
    // After disposal, no new Handler calls can join this scope.
    await Promise.all(this.#running);
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
    requireSupportedHandler(key);
    let result: unknown;
    for (const entry of [...(handlers.get(key) ?? [])]) {
      if (!handlers.get(key)?.includes(entry)) continue;
      let next = false;
      result = await entry.owner.invoke(() => entry.fn.call(entry.self, event, args, () => { next = true; }));
      if (!next && !all) return result;
    }
    return result;
  },
  callAll(key: string, event?: unknown, args?: unknown): Promise<unknown> {
    return Handler.call(key, event, args, true);
  },
};

export default Handler;
