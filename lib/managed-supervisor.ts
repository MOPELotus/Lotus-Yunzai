import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createLocalGit, gitHead } from "./local-git.ts";
import type { ManagedUpdateProgress, ManagedUpdateRequest } from "./managed-update-protocol.ts";
import { spawnManagedWorker } from "./managed-worker.ts";
import { createProcessReceipts } from "./process-receipts.ts";
import { activateUpdate, recoverUpdateActivation } from "./update-activation.ts";
import { prepareUpdate, type ReadyUpdate } from "./update-preflight.ts";
import { stageUpdate } from "./update-staging.ts";

type Worker = ReturnType<typeof spawnManagedWorker>;
type StopSignal = "SIGINT" | "SIGTERM";
type SwitchResult = "updated" | "rolled-back" | "stopped";
type NotifyResult = (result: Exclude<SwitchResult, "stopped">) => Promise<void>;

interface PreparedUpdate {
  readonly revision: string;
  activate(verify: (directory: string) => Promise<void>, statePaths?: readonly string[]): Promise<{ previous: string }>;
}

export function createManagedSupervisor(directory: string, options: { env?: NodeJS.ProcessEnv } = {}) {
  const root = resolve(directory);
  const rootUrl = pathToFileURL(root + sep);
  const receipts = createProcessReceipts(rootUrl);
  const completion = Promise.withResolvers<number>();
  const workers = new Set<Worker>();
  const restarts = new WeakMap<Worker, number | undefined>();
  let current: Worker | undefined;
  let started = false;
  let stopped: StopSignal | undefined;
  let initial: Promise<void> | undefined;
  let transition: Promise<SwitchResult> | undefined;
  let update: { controller: AbortController; done: Promise<void> } | undefined;

  function launch(path = root, expectedRevision?: string, pausedAt?: number, expectedPlugin?: string) {
    const worker: Worker = spawnManagedWorker(path, {
      env: options.env, expectedRevision, held: expectedRevision !== undefined, pausedAt, expectedPlugin,
      onRestart(restartPausedAt) {
        if (current === worker && !stopped) restarts.set(worker, restartPausedAt);
      },
      onUpdate(request, report) {
        if (stopped || current !== worker || update || transition) {
          report("busy");
          return;
        }
        const controller = new AbortController();
        const done = updateFromWorker(worker, request, report, controller.signal).finally(() => { update = undefined; });
        update = { controller, done };
        return done;
      },
    });
    workers.add(worker);
    void worker.exited.then((code) => {
      workers.delete(worker);
      if (current !== worker || stopped) return;
      current = undefined;
      update?.controller.abort();
      if (code === 0 && restarts.has(worker)) {
        void startWorker(restarts.get(worker)).catch(() => completion.resolve(1));
      } else {
        completion.resolve(code);
      }
    });
    return worker;
  }

  async function updateFromWorker(
    worker: Worker, request: ManagedUpdateRequest, report: (status: ManagedUpdateProgress) => void, signal: AbortSignal,
  ) {
    let ready: ReadyUpdate | undefined;
    let stage: Awaited<ReturnType<typeof stageUpdate>> | undefined;
    try {
      report("checking");
      const directories = new Map(request.directories.map(({ name, path, packageName }) => [name, { path, packageName }]));
      const result = await prepareUpdate(rootUrl, directories, request.requested, signal);
      if (result.status !== "ready") {
        if (!signal.aborted) report(result.status);
        return;
      }
      ready = result;
      signal.throwIfAborted();
      report("building");
      stage = await stageUpdate(rootUrl, directories, ready, dirname(root), signal);
      if (stopped || signal.aborted || current !== worker) return;
      report("switching");
      const revision = ready.candidate;
      transition = switchWorker(stage, undefined, async (outcome) => {
        try {
          const destination = { kind: "update", at: Date.now(), target: request.target } as const;
          await receipts.save(outcome === "updated"
            ? { ...destination, result: "updated", revision }
            : { ...destination, result: "rolled-back" });
        } catch {
          console.warn("[更新] 无法保存原会话回执。");
        }
      }, ready.scope === "plugin" ? ready.name : undefined).finally(() => { transition = undefined; });
      await transition;
    } catch {
      if (!stopped && !signal.aborted) {
        if (current === worker) report("failed");
        else console.error("[更新] 无法完成托管宿主切换，请核对恢复记录。");
      }
    } finally {
      await stage?.release().catch(() => console.warn("[更新] 无法清理候选目录。"));
      await ready?.release().catch(() => console.warn("[更新] 无法清理临时候选引用。"));
    }
  }

  async function startWorker(pausedAt?: number) {
    if (stopped) return;
    const worker = launch(root, undefined, pausedAt);
    current = worker;
    await worker.ready;
  }

  async function restartPrevious(notify?: NotifyResult) {
    if (stopped) return "stopped" as const;
    try {
      await notify?.("rolled-back");
      await startWorker();
    } catch {
      completion.resolve(1);
      throw new Error("旧宿主未能重新启动。");
    }
    return stopped ? "stopped" as const : "rolled-back" as const;
  }

  async function switchWorker(
    stage: PreparedUpdate, statePaths?: readonly string[], notify?: NotifyResult, expectedPlugin?: string,
  ) {
    const previousWorker = current;
    if (!previousWorker || stopped) throw new Error("没有可交接的活动宿主。");
    current = undefined;
    const oldExit = await previousWorker.stop();
    if (stopped) return "stopped" as const;
    if (oldExit !== 143 && oldExit !== 0) return restartPrevious(notify);

    const git = createLocalGit();
    const original = await git?.(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    let candidate: Worker | undefined;
    let previous: string | undefined;
    try {
      ({ previous } = await stage.activate(async (active) => {
        if (stopped) throw new Error("更新交接已停止。");
        const worker = launch(active, stage.revision, undefined, expectedPlugin);
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
      await notify?.("updated");
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
      return restartPrevious(notify);
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
        update?.controller.abort();
        await Promise.allSettled([
          ...[...workers].map((worker) => worker.stop(signal)), initial, transition, update?.done,
        ]);
        completion.resolve(signal === "SIGINT" ? 130 : 143);
      }
      return completion.promise;
    },
  };
}
