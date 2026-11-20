import { readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readInstallCatalog } from "./install-catalog.ts";
import { preparePluginInstall, type ReadyInstall } from "./install-preflight.ts";
import { createLocalGit, gitHead } from "./local-git.ts";
import type { ManagedUpdateProgress, ManagedUpdateRequest } from "./managed-update-protocol.ts";
import { spawnManagedWorker } from "./managed-worker.ts";
import { createProcessReceipts, type ProcessReceipt } from "./process-receipts.ts";
import { sanitizeRuntimeLog } from "./runtime-logs.ts";
import { activateUpdate, recoverUpdateActivation, type ActivatedUpdate } from "./update-activation.ts";
import { prepareAllUpdates, prepareUpdate, type ReadyBatchUpdate, type ReadyUpdate } from "./update-preflight.ts";
import { stageUpdate } from "./update-staging.ts";
import { readUpdateRuntimePaths } from "./update-runtime-paths.ts";

type Worker = ReturnType<typeof spawnManagedWorker>;
type StopSignal = "SIGINT" | "SIGTERM";
type SwitchResult = "updated" | "rolled-back" | "stopped";
type NotifyResult = (result: Exclude<SwitchResult, "stopped">, previous?: string) => Promise<void>;

interface PreparedUpdate {
  readonly revision: string;
  activate(verify: (directory: string) => Promise<void>, statePaths?: readonly string[]): Promise<ActivatedUpdate>;
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

  function launch(path = root, expectedRevision?: string, pausedAt?: number, expectedPlugins?: readonly string[]) {
    const worker: Worker = spawnManagedWorker(path, {
      env: options.env, expectedRevision, held: expectedRevision !== undefined, pausedAt, expectedPlugins,
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
    let ready: ReadyUpdate | ReadyBatchUpdate | ReadyInstall | undefined;
    let stage: Awaited<ReturnType<typeof stageUpdate>> | undefined;
    const log = request.install ? "[插件安装]" : "[更新]";
    try {
      report("checking");
      const directories = new Map(request.directories.map(({ name, path, packageName }) => [name, { path, packageName }]));
      const approved = request.install ? (await readInstallCatalog(rootUrl)).resolve(request.install) : undefined;
      if (request.install && !approved) {
        report("unavailable");
        return;
      }
      const result = approved
        ? await preparePluginInstall(rootUrl, directories, approved, dirname(root), signal)
        : request.all
        ? await prepareAllUpdates(rootUrl, directories, signal, request.force)
        : await prepareUpdate(rootUrl, directories, request.requested, signal, request.force);
      if (result.status !== "ready") {
        if ("target" in result && typeof result.target === "string" && result.status !== "current" && !signal.aborted) {
          console.warn(`[更新] ${sanitizeRuntimeLog(result.target, 120)} 未通过全量更新检查（${result.status}）。`);
        }
        if (!signal.aborted) report(result.status === "exists" ? "current" : result.status);
        return;
      }
      ready = result;
      signal.throwIfAborted();
      report("building");
      stage = await stageUpdate(rootUrl, directories, ready, dirname(root), signal);
      if (stopped || signal.aborted || current !== worker) return;
      const revision = ready.scope === "all" ? ready.host.candidate : ready.scope === "install" ? stage.revision : ready.candidate;
      const repositories = ready.scope === "all"
        ? Number(ready.host.current !== ready.host.candidate || ready.host.force === true) + ready.plugins.size : undefined;
      let expectedPlugins: readonly string[] | undefined;
      if (ready.scope === "all") {
        const installed = new Set(await readdir(join(stage.directory, "plugins")));
        expectedPlugins = [...directories.keys()].filter((name) => installed.has(name));
      } else if (ready.scope === "plugin") {
        expectedPlugins = [ready.name];
      } else if (ready.scope === "install") {
        expectedPlugins = [...directories.keys(), ready.plugin.name];
      }
      if (stopped || signal.aborted || current !== worker) return;
      report("switching");
      const target = request.target;
      const targets: readonly ProcessReceipt["target"][] = target.type === "scheduled"
        ? [
          ...target.botIds.map((botId) => ({ type: "masters" as const, botId })),
          ...(target.milkyBotIds ?? []).map((botId) => ({ type: "masters" as const, botId, adapter: "milky" as const })),
          ...(target.terminal ? [{ type: "terminal" as const }] : []),
        ] : [target];
      let archived: string | undefined;
      const installed = ready.scope === "install" ? ready.plugin : undefined;
      transition = switchWorker(stage, () => readUpdateRuntimePaths(root, signal, options.env ?? process.env), async (outcome, previous) => {
        if (outcome === "updated") archived = previous;
        const at = Date.now();
        const saved = await Promise.allSettled(targets.map((target) => {
          if (installed && approved && target.type !== "masters") {
            const destination = { kind: "install", at, target, name: approved.name } as const;
            return receipts.save(outcome === "updated"
              ? { ...destination, result: "installed", revision: installed.revision }
              : { ...destination, result: "rolled-back" });
          }
          const destination = { kind: "update", at, target } as const;
          return receipts.save(outcome === "updated"
            ? { ...destination, result: "updated", revision, repositories,
              ...(request.force ? { preserved: true } : {}) }
            : { ...destination, result: "rolled-back" });
        }));
        if (saved.some((item) => item.status === "rejected")) {
          console.warn(`${log} 部分会话的操作回执未能保存。`);
        }
      }, expectedPlugins).finally(() => { transition = undefined; });
      const outcome = await transition;
      if (request.force && outcome === "updated" && archived) {
        console.log(`[更新] 强制更新前的工作区保存在 ${JSON.stringify(archived)}。`);
      }
      if (target.type === "scheduled") {
        if (outcome === "updated") console.log("[更新] 定时更新成功。");
        if (outcome === "rolled-back") console.warn("[更新] 定时更新失败，已恢复旧版本。");
      }
    } catch (error) {
      if (!stopped && !signal.aborted) {
        if (current === worker) {
          if (error instanceof Error) console.warn(`${log} ${sanitizeRuntimeLog(error.message, 240)}`);
          report("failed");
        } else {
          console.error(`${log} 无法完成托管宿主切换，请核对恢复记录。`);
        }
      }
    } finally {
      await stage?.release().catch(() => console.warn(`${log} 无法清理候选目录。`));
      await ready?.release().catch(() => console.warn(`${log} 无法清理临时候选来源。`));
    }
  }

  async function startWorker(pausedAt?: number) {
    if (stopped) return;
    const worker = launch(root, undefined, pausedAt);
    current = worker;
    await worker.ready;
  }

  async function restartPrevious(notify?: NotifyResult, pausedAt?: number) {
    if (stopped) return "stopped" as const;
    try {
      await notify?.("rolled-back");
      await startWorker(pausedAt);
    } catch {
      completion.resolve(1);
      throw new Error("旧宿主未能重新启动。");
    }
    return stopped ? "stopped" as const : "rolled-back" as const;
  }

  async function switchWorker(
    stage: PreparedUpdate, readStatePaths?: () => readonly string[] | Promise<readonly string[]>,
    notify?: NotifyResult, expectedPlugins?: readonly string[],
  ) {
    const previousWorker = current;
    if (!previousWorker || stopped) throw new Error("没有可交接的活动宿主。");
    current = undefined;
    const oldExit = await previousWorker.stop();
    const pausedAt = previousWorker.pausedAt;
    if (stopped) return "stopped" as const;
    if (oldExit !== 143 && oldExit !== 0) {
      console.warn(`[更新] 原宿主以 ${oldExit} 退出，正在重新启动原版本。`);
      return restartPrevious(notify, pausedAt);
    }

    const git = createLocalGit();
    const original = await git?.(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    let candidate: Worker | undefined;
    let activated: ActivatedUpdate | undefined;
    try {
      // SQLite can create or remove companion files while the old worker is shutting down.
      const statePaths = await readStatePaths?.();
      if (stopped) return "stopped" as const;
      activated = await stage.activate(async (active) => {
        if (stopped) throw new Error("更新交接已停止。");
        const worker = launch(active, stage.revision, pausedAt, expectedPlugins);
        candidate = worker;
        try {
          await worker.ready;
          if (stopped) throw new Error("更新交接已停止。");
        } catch (error) {
          await worker.stop(stopped);
          throw error;
        }
      }, statePaths);
      if (!candidate) throw new Error("候选宿主未启动。");
      if (stopped) {
        await candidate.stop(stopped);
        return "stopped" as const;
      }
      await notify?.("updated", activated.previous);
      if (stopped) {
        await candidate.stop(stopped);
        return "stopped" as const;
      }
      candidate.activate();
      current = candidate;
      return "updated" as const;
    } catch {
      if (!stopped) {
        console.warn(candidate ? "[更新] 候选宿主未能完成交接，正在恢复原版本。" : "[更新] 文件切换失败，正在恢复原版本。");
      }
      await candidate?.stop(stopped);
      try {
        if (activated && !stopped) await activateUpdate(root, activated.previous, async () => {}, activated.state);
        else await recoverUpdateActivation(root);
        if (!stopped && original) {
          const check = createLocalGit();
          if (!check || await gitHead(check, root) !== original.trim()) throw new Error();
        }
      } catch {
        completion.resolve(1);
        throw new Error("宿主版本恢复失败。");
      }
      return restartPrevious(notify, pausedAt);
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
      transition = switchWorker(stage, statePaths && (() => statePaths)).finally(() => { transition = undefined; });
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
