/** FIFO permits; cancelled waiters never release the current owner's permit. */
export function createTaskQueue() {
  let tail = Promise.resolve();
  return {
    async acquire(signal?: AbortSignal) {
      signal?.throwIfAborted();
      const previous = tail;
      const released = Promise.withResolvers<void>();
      tail = previous.then(() => released.promise);
      let abort = () => {};
      try {
        await Promise.race([previous, new Promise<never>((_, reject) => {
          abort = () => reject(signal?.reason);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        })]);
        signal?.throwIfAborted();
        return released.resolve;
      } catch (error) {
        void previous.then(released.resolve);
        throw error;
      } finally { signal?.removeEventListener('abort', abort); }
    },
  };
}
