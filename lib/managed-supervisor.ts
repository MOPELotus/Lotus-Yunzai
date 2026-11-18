import { resolve } from "node:path";
import { createLocalGit, gitHead } from "./local-git.ts";
import { spawnManagedWorker } from "./managed-worker.ts";
import { activateUpdate, recoverUpdateActivation } from "./update-activation.ts";

type Worker = ReturnType<typeof spawnManagedWorker>;
type StopSignal = "SIGINT" | "SIGTERM";

interface PreparedUpdate {
  readonly revision: string;
  activate(verify: (directory: string) => Promise<void>, statePaths?: readonly string[]): Promise<{ previous: string }>;
}

export function createManagedSupervisor(directory: string, options: { env?: NodeJS.ProcessEnv } = {}) {
  const root = resolve(directory);
  const completion = Promise.withResolvers<number>();
  const workers = new Set<Worker>();
  const restarts = new WeakMap<Worker, number | undefined>();
  let current: Worker | undefined;
  let started = false;
  let stopped: StopSignal | undefined;
  let initial: Promise<void> | undefined;
  let transition: Promise<"updated" | "rolled-back" | "stopped"> | undefined;

  function launch(path = root, expectedRevision?: string, pausedAt?: number) {
    const worker: Worker = spawnManagedWorker(path, {
      env: options.env, expectedRevision, held: expectedRevision !== undefined, pausedAt,
      onRestart(restartPausedAt) {
        if (current === worker && !stopped) restarts.set(worker, restartPausedAt);
      },
    });
    workers.add(worker);
    void worker.exited.then((code) => {
      workers.delete(worker);
      if (current !== worker || stopped) return;
      current = undefined;
      if (code === 0 && restarts.has(worker)) {
        void startWorker(restarts.get(worker)).catch(() => completion.resolve(1));
      } else {
        completion.resolve(code);
      }
    });
    return worker;
  }

  async function startWorker(pausedAt?: number) {
    if (stopped) return;
    const worker = launch(root, undefined, pausedAt);
    current = worker;
    await worker.ready;
  }

  async function restartPrevious() {
    if (stopped) return "stopped" as const;
    try {
      await startWorker();
    } catch {
      completion.resolve(1);
      throw new Error("旧宿主未能重新启动。");
    }
    return stopped ? "stopped" as const : "rolled-back" as const;
  }

  async function switchWorker(stage: PreparedUpdate, statePaths?: readonly string[]) {
    const previousWorker = current;
    if (!previousWorker || stopped) throw new Error("没有可交接的活动宿主。");
    current = undefined;
    const oldExit = await previousWorker.stop();
    if (stopped) return "stopped" as const;
    if (oldExit !== 143 && oldExit !== 0) return restartPrevious();

    const git = createLocalGit();
    const original = await git?.(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    let candidate: Worker | undefined;
    let previous: string | undefined;
    try {
      ({ previous } = await stage.activate(async (active) => {
        if (stopped) throw new Error("更新交接已停止。");
        const worker = launch(active, stage.revision);
        candidate = worker;
        try {
          await worker.ready;
          if (stopped) throw new Error("更新交接已停止。");
        } catch (error) {
          await worker.stop(stopped);
          throw error;
        }
      }, statePaths));
      if (!candidate) throw new Error("候选宿主未启动。");
      if (stopped) {
        await candidate.stop(stopped);
        return "stopped" as const;
      }
      candidate.activate();
      current = candidate;
      return "updated" as const;
    } catch {
      await candidate?.stop(stopped);
      try {
        if (previous && !stopped) await activateUpdate(root, previous, async () => {}, statePaths);
        else await recoverUpdateActivation(root);
        if (!stopped && original) {
          const check = createLocalGit();
          if (!check || await gitHead(check, root) !== original.trim()) throw new Error();
        }
      } catch {
        completion.resolve(1);
        throw new Error("宿主版本恢复失败。");
      }
      return restartPrevious();
    }
  }

  return {
    done: completion.promise,
    start(): Promise<void> {
      if (started || stopped) return Promise.reject(new Error("托管宿主已启动或停止。"));
      started = true;
      initial = (async () => {
        await recoverUpdateActivation(root);
        await startWorker();
      })().catch((error: unknown) => {
        if (!current && !stopped) completion.resolve(1);
        throw error;
      });
      return initial;
    },
    replace(stage: PreparedUpdate, statePaths?: readonly string[]) {
      if (!current || stopped || transition) return Promise.reject(new Error("托管宿主暂不可切换。"));
      transition = switchWorker(stage, statePaths).finally(() => { transition = undefined; });
      return transition;
    },
    async stop(signal: StopSignal = "SIGTERM") {
      if (!stopped) {
        stopped = signal;
        await Promise.allSettled([
          ...[...workers].map((worker) => worker.stop(signal)), initial, transition,
        ]);
        completion.resolve(signal === "SIGINT" ? 130 : 143);
      }
      return completion.promise;
    },
  };
}
