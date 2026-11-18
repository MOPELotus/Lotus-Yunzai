import type { MessageEvent } from "../messages.ts";

interface ContextEntry {
  readonly origin: MessageEvent;
  readonly timer?: ReturnType<typeof setTimeout>;
  readonly resolve?: (event: MessageEvent | false) => void;
}

export class PluginContexts {
  readonly #sessions = new Map<string, Map<string, ContextEntry>>();
  #closed = false;

  get active(): boolean {
    return this.#sessions.size > 0;
  }

  #key(event: MessageEvent, group: boolean): string | undefined {
    if (event.message_type === "terminal") return group ? undefined : "terminal";
    if (group) return event.group_id === undefined ? undefined
      : JSON.stringify([event.self_id, "group", event.group_id]);
    if (event.user_id === undefined) return;
    return JSON.stringify([event.self_id, event.message_type, event.group_id, event.user_id]);
  }

  set(
    event: MessageEvent,
    method: string,
    group: boolean,
    seconds: number,
    timeout: string,
    resolve?: ContextEntry["resolve"],
  ): MessageEvent | undefined {
    const key = this.#key(event, group);
    if (this.#closed || key === undefined) return;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 2_147_483) {
      throw new RangeError("插件会话的超时时间无效。");
    }

    const entries = this.#sessions.get(key) ?? new Map<string, ContextEntry>();
    const old = entries.get(method);
    if (old?.timer) clearTimeout(old.timer);
    old?.resolve?.(false);
    const timer = seconds > 0 ? setTimeout(() => {
      this.finish(event, method, group);
      if (timeout) event.reply(timeout, true);
    }, seconds * 1000) : undefined;
    timer?.unref();
    entries.set(method, { origin: event, timer, resolve });
    this.#sessions.set(key, entries);
    return event;
  }

  wait(event: MessageEvent, group: boolean, seconds: number): Promise<MessageEvent | false> {
    const { promise, resolve } = Promise.withResolvers<MessageEvent | false>();
    const origin = this.set(event, "resolveContext", group, seconds, "", resolve);
    if (origin) event.onAwaitInput?.();
    else resolve(false);
    return promise;
  }

  resolve(event: MessageEvent): boolean {
    for (const group of [true, false]) {
      const key = this.#key(event, group);
      if (key === undefined || !this.#sessions.get(key)?.get("resolveContext")?.resolve) continue;

      this.#remove(key, "resolveContext")?.resolve?.(event);
      return true;
    }
    return false;
  }

  get(event: MessageEvent, group: boolean): Record<string, MessageEvent> {
    const key = this.#key(event, group);
    const entries = key === undefined ? undefined : this.#sessions.get(key);
    return Object.fromEntries([...(entries ?? [])].map(([name, entry]) => [name, entry.origin]));
  }

  finish(event: MessageEvent, method: string, group: boolean): void {
    const key = this.#key(event, group);
    if (key !== undefined) this.#remove(key, method)?.resolve?.(false);
  }

  #remove(key: string, method: string): ContextEntry | undefined {
    const entries = this.#sessions.get(key);
    const entry = entries?.get(method);
    if (entry?.timer) clearTimeout(entry.timer);
    entries?.delete(method);
    if (entries?.size === 0) this.#sessions.delete(key);
    return entry;
  }

  close(): void {
    this.#closed = true;
    for (const entries of this.#sessions.values()) {
      for (const { timer, resolve } of entries.values()) {
        if (timer) clearTimeout(timer);
        resolve?.(false);
      }
    }
    this.#sessions.clear();
  }
}
