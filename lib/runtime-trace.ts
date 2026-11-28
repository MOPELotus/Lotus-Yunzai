import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const trace = new AsyncLocalStorage<string>();
export const runtimeTraceId = () => trace.getStore();

export function tracePanelCacheTask(task: 'gs-panel-cache' | 'sr-panel-cache' | 'zzz-panel-cache',
  run: () => Promise<void>, report: (entry: { task: string; taskId: string; state: 'started' | 'finished' | 'failed' }) => void) {
  return () => {
    const taskId = randomUUID();
    return trace.run(taskId, async () => {
      report({ task, taskId, state: 'started' });
      try { await run(); report({ task, taskId, state: 'finished' }); }
      catch (error) { report({ task, taskId, state: 'failed' }); throw error; }
    });
  };
}
