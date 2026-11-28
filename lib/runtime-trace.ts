import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createTaskQueue } from './task-queue.ts';

const trace = new AsyncLocalStorage<string>();
export const runtimeTraceId = () => trace.getStore();
export interface PanelCacheSummary { refreshed: number; failed: number; busy: number; skipped: number }
export interface PanelCacheTrace extends PanelCacheSummary {
  task: string; taskId: string; state: 'queued' | 'started' | 'finished' | 'partial' | 'failed';
}
const panelQueue = createTaskQueue();
let pendingPanelTasks = 0;

export function tracePanelCacheTask(task: 'gs-panel-cache' | 'sr-panel-cache' | 'zzz-panel-cache',
  run: () => Promise<PanelCacheSummary | void>, report: (entry: PanelCacheTrace) => void, signal?: AbortSignal) {
  let running: Promise<void> | undefined;
  return () => {
    if (running) return running;
    const taskId = randomUUID();
    running = trace.run(taskId, async () => {
      let release: (() => void) | undefined;
      let counts: PanelCacheSummary = { refreshed: 0, failed: 0, busy: 0, skipped: 0 };
      const emit = (state: PanelCacheTrace['state']) => report({ task, taskId, state, ...counts });
      const queued = pendingPanelTasks++ > 0;
      try {
        if (queued) emit('queued');
        release = await panelQueue.acquire(signal);
        signal?.throwIfAborted();
        emit('started');
        counts = await run() ?? counts;
        signal?.throwIfAborted();
        emit(counts.failed || counts.busy ? 'partial' : 'finished');
      } catch (error) { emit('failed'); throw error; }
      finally { pendingPanelTasks--; release?.(); }
    }).finally(() => { running = undefined; });
    return running;
  };
}
