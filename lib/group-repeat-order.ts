import { AsyncLocalStorage } from "node:async_hooks";

interface Observation {
  readonly group: number;
  readonly previous: Promise<void>;
  readonly receivedAt: number;
  release(): void;
  scheduled: boolean;
}

export function createGroupRepeatOrder(signal: AbortSignal) {
  const context = new AsyncLocalStorage<Observation | undefined>();
  const tails = new Map<number, Promise<void>>();
  const waiting = new Set<Observation>();

  signal.addEventListener("abort", () => {
    for (const observation of waiting) observation.release();
  }, { once: true });

  function dispatch<T>(group: number | undefined, run: () => Promise<T>): Promise<T> {
    if (group === undefined || signal.aborted) return context.run(undefined, run);

    const previous = tails.get(group) ?? Promise.resolve();
    const finished = Promise.withResolvers<void>();
    const observation: Observation = {
      group, previous, receivedAt: performance.now(), scheduled: false,
      release() {
        waiting.delete(observation);
        finished.resolve();
      },
    };
    waiting.add(observation);
    const tail = previous.then(() => finished.promise);
    tails.set(group, tail);
    void tail.then(() => { if (tails.get(group) === tail) tails.delete(group); });

    return context.run(observation, async () => {
      try {
        return await run();
      } finally {
        if (!observation.scheduled) observation.release();
      }
    });
  }

  function observe(group: number, run: (receivedAt?: number) => Promise<void>): Promise<void> | undefined {
    const observation = context.getStore();
    if (!observation || observation.group !== group) return;
    if (observation.scheduled) return Promise.resolve();
    observation.scheduled = true;
    return observation.previous.then(() => {
      try {
        if (!signal.aborted) return run(observation.receivedAt);
      } finally {
        // Claim the run before releasing the next observation; fetching media and
        // sending the reply never hold the queue.
        observation.release();
      }
    });
  }

  return { dispatch, observe };
}
