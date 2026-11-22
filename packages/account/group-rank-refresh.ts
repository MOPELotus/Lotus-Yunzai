export type GroupRankRefreshResult<Entry, Value> =
  | { readonly entry: Entry; readonly status: "fresh"; readonly value: Value }
  | { readonly entry: Entry; readonly status: "not-listed" | "failed" };

/** Share one refresher across queries to the same provider. Callers provide unique, authorized entries. */
export function createGroupRankRefresh(concurrency = 3) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError("无效的群榜刷新并发数。");
  const waiting = new Set<() => void>();
  let active = 0;

  function acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (active < concurrency) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", cancel);
        active++;
        resolve();
      };
      const cancel = () => {
        waiting.delete(grant);
        reject(signal.reason);
      };
      waiting.add(grant);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  function release() {
    active--;
    const next = waiting.values().next().value;
    if (next) {
      waiting.delete(next);
      next();
    }
  }

  return async function refresh<Entry, Value>(entries: readonly Entry[],
    read: (entry: Entry, signal: AbortSignal) => Promise<Value | undefined>, signal: AbortSignal) {
    signal.throwIfAborted();
    const pending = entries.entries();
    const results = new Array<GroupRankRefreshResult<Entry, Value>>(entries.length);
    async function worker() {
      for (const [index, entry] of pending) {
        await acquire(signal);
        try {
          signal.throwIfAborted();
          const value = await read(entry, signal);
          signal.throwIfAborted();
          results[index] = value === undefined ? { entry, status: "not-listed" } : { entry, status: "fresh", value };
        } catch {
          signal.throwIfAborted();
          results[index] = { entry, status: "failed" };
        } finally {
          release();
        }
      }
    }
    // Each worker pulls one entry at a time from the shared iterator.
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
    signal.throwIfAborted();
    return results;
  };
}
