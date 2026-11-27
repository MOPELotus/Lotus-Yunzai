import { readAppliedUpdateReports, type AppliedUpdateReport } from "./update-report.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readInstallCatalog } from "./install-catalog.ts";
import { preparePluginInstall, type ReadyInstall } from "./install-preflight.ts";
import { createLocalGit, gitHead } from "./local-git.ts";
import type { ManagedUpdateProgress, ManagedUpdateRequest } from "./managed-update-protocol.ts";
import type { ManagedEndpoints } from "./managed-handoff.ts";
import { ManagedEndpointUnavailableError, spawnManagedWorker } from "./managed-worker.ts";
import { legacyScriptHash, readFlatScript } from "./plugins/file-watch.ts";
import { createProcessReceipts, type ProcessReceipt } from "./process-receipts.ts";
import { sanitizeRuntimeLog } from "./runtime-logs.ts";
import { activateUpdate, recoverUpdateActivation, type ActivatedUpdate } from "./update-activation.ts";
import { recoverMigrationPublicationWithHostLock } from "./migration-publication.ts";
import { prepareAllUpdates, prepareUpdate, type ReadyBatchUpdate, type ReadyUpdate } from "./update-preflight.ts";
import { stageUpdate } from "./update-staging.ts";
import { readManagedHttpsPaths } from "./update-https-paths.ts";
import { readUpdateRuntimePaths } from "./update-runtime-paths.ts";
import { readWebMountUpdatePaths, WebMountUpdateError } from "./update-web-mount.ts";
import { readStorageRevision, storageRevision, type StorageSnapshot } from "./valkey-config.ts";

type Worker = ReturnType<typeof spawnManagedWorker>;
type StopSignal = "SIGINT" | "SIGTERM";
type SwitchResult = "updated" | "rolled-back" | "stopped";
type NotifyResult = (result: Exclude<SwitchResult, "stopped">, previous?: string) => Promise<void>;

interface PreparedUpdate {
  readonly revision: string;
  activate(verify: (directory: string) => Promise<void>, statePaths?: readonly string[]): Promise<ActivatedUpdate>;
}

async function retainedLegacyScripts(root: string, scripts: readonly string[]) {
  const retained = await Promise.all(scripts.map(async script => {
    try {
      await lstat(join(root, "plugins", script));
      return script;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      return undefined;
    }
  }));
  return retained.filter(script => script !== undefined);
}

export function createManagedSupervisor(directory: string, options: {
  env?: NodeJS.ProcessEnv; onWorkerReady?: (ready: boolean) => void;
  powerState?: { path: string; attempt: string };
} = {}) {
  const root = resolve(directory);
  const rootUrl = pathToFileURL(root + sep);
  const receipts = createProcessReceipts(rootUrl);
  const completion = Promise.withResolvers<number>();
  const workers = new Set<Worker>();
  const restarts = new WeakMap<Worker, number | undefined>();
  let current: Worker | undefined;
  let workerReady = false;
  let started = false;
  let stopped: StopSignal | undefined;
  let initial: Promise<void> | undefined;
  let transition: Promise<SwitchResult> | undefined;
  let update: { controller: AbortController; done: Promise<void> } | undefined;

  function reportWorkerReady(ready: boolean) {
    if (workerReady === ready) return;
    workerReady = ready;
    try {
      options.onWorkerReady?.(ready);
    } catch {
      console.warn($t("lib.managed-supervisor.text_1c6402dff0"));
    }
  }

  function launch(path = root, startup: {
    expectedRevision?: string; pausedAt?: number; expectedPlugins?: readonly string[];
    expectedScripts?: readonly string[]; expectedEndpoints?: ManagedEndpoints;
    expectedStorage?: StorageSnapshot; restoreStorage?: StorageSnapshot;
  } = {}) {
    const worker: Worker = spawnManagedWorker(path, {
      ...startup, env: options.env, powerState: options.powerState, held: startup.expectedRevision !== undefined,
      onRestart(restartPausedAt) {
        if (current === worker && !stopped) {
          restarts.set(worker, restartPausedAt);
          reportWorkerReady(false);
        }
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
      reportWorkerReady(false);
      update?.controller.abort();
      if (code === 0 && restarts.has(worker)) {
        void startWorker(restarts.get(worker), worker.storage).catch(() => completion.resolve(1));
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
    const log = request.install ? $t("lib.managed-supervisor.text_13c5481870") : $t("lib.managed-supervisor.text_59e89cebf5");
    const active = () => !stopped && !signal.aborted && current === worker;
    const storageMatches = async () => {
      if (worker.storage === undefined) return active();
      const diskRevision = await readStorageRevision(root, options.env ?? process.env, signal);
      if (!active()) return false;
      if (diskRevision === storageRevision(worker.storage)) return true;
      console.warn($t("lib.managed-supervisor.text_7fdd692944", { "log": log }));
      report("storage-changed");
      return false;
    };
    try {
      report("checking");
      if (!await storageMatches()) return;
      const directories = new Map(request.directories.map(({ name, path, packageName }) => [name, { path, packageName }]));
      const approved = request.install ? (await readInstallCatalog(rootUrl)).resolve(request.install) : undefined;
      if (request.install && !approved) {
        report("unavailable");
        return;
      }
      const result = approved
        ? await preparePluginInstall(rootUrl, directories, approved, dirname(root), signal)
        : request.all
        ? await prepareAllUpdates(rootUrl, directories, signal, request.force, report)
        : await prepareUpdate(rootUrl, directories, request.requested, signal, request.force, report);
      if (result.status !== "ready") {
        if ("target" in result && typeof result.target === "string" && result.status !== "current" && !signal.aborted) {
          console.warn($t("lib.managed-supervisor.text_7c6f0646d4", { "value1": sanitizeRuntimeLog(result.target, 120), "status": result.status }));
        }
        if (!signal.aborted) report(result.status === "exists" ? "current" : result.status);
        return;
      }
      ready = result;
      signal.throwIfAborted();
      let applied: AppliedUpdateReport[] = [];
      const started = Date.now();
      const heartbeat = setInterval(() => {
        if (!request.quiet && active()) report(`waiting:${Math.floor((Date.now() - started) / 1000)}`);
      }, 30_000);
      try {
        stage = await stageUpdate(rootUrl, directories, ready, dirname(root), signal, report);
        if (ready.scope !== "install") {
          try { applied = await readAppliedUpdateReports(root, stage.directory, [...directories.keys()], signal); }
          catch { signal.throwIfAborted(); console.warn($t("lib.update-report.read-failed")); }
        }
      } finally {
        clearInterval(heartbeat);
      }
      if (stopped || signal.aborted || current !== worker) return;
      const revision = ready.scope === "all" ? ready.host.candidate : ready.scope === "install" ? stage.revision : ready.candidate;
      const repositories = ready.scope === "all"
        ? Math.max(1, applied.length) : undefined;
      // An update can affect the retained plugins regardless of which repository was requested.
      const stagedPlugins = ready.scope === "install" ? undefined : new Set(await readdir(join(stage.directory, "plugins")));
      const expectedPlugins = new Set([...directories.keys()].filter(name => !stagedPlugins || stagedPlugins.has(name)));
      if (ready.scope === "plugin") expectedPlugins.add(ready.name);
      if (ready.scope === "install") expectedPlugins.add(ready.plugin.name);
      for (const [script, hash] of request.watchedScriptHashes ?? []) {
        signal.throwIfAborted();
        const path = join(root, "plugins", script);
        const bytes = (await lstat(dirname(path))).isDirectory() ? await readFlatScript(path) : undefined;
        if (!bytes || legacyScriptHash(bytes) !== hash) {
          throw new Error($t("lib.managed-supervisor.text_9de9cc7cdb", { "value1": JSON.stringify(script) }));
        }
      }
      if (!active() || !await storageMatches()) return;
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
      const statePaths = async () => [
        ...await readUpdateRuntimePaths(root, signal, options.env ?? process.env),
        ...await readManagedHttpsPaths(rootUrl),
        ...await readWebMountUpdatePaths(rootUrl),
      ];
      transition = switchWorker(stage, statePaths, async (outcome, previous) => {
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
            ? { ...destination, result: "updated", revision, repositories, ...(applied.length ? { reports: applied } : {}),
              ...(request.force ? { preserved: true } : {}) }
            : { ...destination, result: "rolled-back" });
        }));
        if (saved.some((item) => item.status === "rejected")) {
          console.warn($t("lib.managed-supervisor.text_422ac281ce", { "log": log }));
        }
      }, [...expectedPlugins], request.scripts).finally(() => { transition = undefined; });
      const outcome = await transition;
      if (request.force && outcome === "updated" && archived) {
        console.log($t("lib.managed-supervisor.text_98047210be", { "value1": JSON.stringify(archived) }));
      }
      if (target.type === "scheduled") {
        if (outcome === "updated") console.log($t("lib.managed-supervisor.text_4d8722f319"));
        if (outcome === "rolled-back") console.warn($t("lib.managed-supervisor.text_69ed48fd1a"));
      }
    } catch (error) {
      if (!stopped && !signal.aborted) {
        if (current === worker) {
          if (error instanceof Error) console.warn(`${log} ${sanitizeRuntimeLog(error.message, 240)}`);
          report("failed");
        } else {
          console.error($t("lib.managed-supervisor.text_9cf529b177", { "log": log }));
        }
      }
    } finally {
      await stage?.release().catch(() => console.warn($t("lib.managed-supervisor.text_af743bde5e", { "log": log })));
      await ready?.release().catch(() => console.warn($t("lib.managed-supervisor.text_4717004913", { "log": log })));
    }
  }

  async function startWorker(pausedAt?: number, restoreStorage?: StorageSnapshot) {
    if (stopped) return;
    const worker = launch(root, { pausedAt, restoreStorage });
    current = worker;
    await worker.ready;
    if (current === worker && !stopped && worker.serving) reportWorkerReady(true);
  }

  async function restartPrevious(notify?: NotifyResult, pausedAt?: number, storage?: StorageSnapshot) {
    if (stopped) return "stopped" as const;
    try {
      await notify?.("rolled-back");
      await startWorker(pausedAt, storage);
    } catch {
      completion.resolve(1);
      throw new Error($t("lib.managed-supervisor.text_b629c247bb"));
    }
    return stopped ? "stopped" as const : "rolled-back" as const;
  }

  async function switchWorker(
    stage: PreparedUpdate, readStatePaths?: () => readonly string[] | Promise<readonly string[]>,
    notify?: NotifyResult, expectedPlugins?: readonly string[], activeScripts: readonly string[] = [],
  ) {
    const previousWorker = current;
    if (!previousWorker || stopped) throw new Error($t("lib.managed-supervisor.text_48108ed228"));
    current = undefined;
    reportWorkerReady(false);
    const oldExit = await previousWorker.stop("SIGTERM", true);
    const pausedAt = previousWorker.pausedAt;
    if (stopped) return "stopped" as const;
    if (oldExit !== 143 && oldExit !== 0) {
      console.warn($t("lib.managed-supervisor.text_2f3aa6f661", { "oldExit": oldExit }));
      return restartPrevious(notify, pausedAt, previousWorker.storage);
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
        if (stopped) throw new Error($t("lib.managed-supervisor.text_13e0a82a8b"));
        // Flat scripts may only be copied into the active checkout during activation.
        const expectedScripts = await retainedLegacyScripts(active, activeScripts);
        if (stopped) throw new Error($t("lib.managed-supervisor.text_13e0a82a8b"));
        const worker = launch(active, {
          expectedRevision: stage.revision, pausedAt, expectedPlugins, expectedScripts, expectedEndpoints: previousWorker.endpoints,
          expectedStorage: previousWorker.storage,
        });
        candidate = worker;
        try {
          await worker.ready;
          if (stopped) throw new Error($t("lib.managed-supervisor.text_13e0a82a8b"));
        } catch (error) {
          await worker.stop(stopped);
          throw error;
        }
      }, statePaths);
      if (!candidate) throw new Error($t("lib.managed-supervisor.text_cea596475d"));
      if (stopped) {
        await candidate.stop(stopped);
        return "stopped" as const;
      }
      await notify?.("updated", activated.previous);
      if (stopped) {
        await candidate.stop(stopped);
        return "stopped" as const;
      }
      await candidate.activate();
      if (stopped) {
        await candidate.stop(stopped);
        return "stopped" as const;
      }
      if (!candidate.serving) throw new ManagedEndpointUnavailableError($t("lib.managed-supervisor.text_52339f7132"));
      current = candidate;
      reportWorkerReady(true);
      return "updated" as const;
    } catch (error) {
      if (!stopped) {
        if (error instanceof WebMountUpdateError || error instanceof ManagedEndpointUnavailableError) console.warn($t("lib.managed-supervisor.text_36e39a7845", { "message": error.message }));
        console.warn(candidate ? $t("lib.managed-supervisor.text_6197723435") : $t("lib.managed-supervisor.text_182b8e292f"));
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
        throw new Error($t("lib.managed-supervisor.text_74ea41fbff"));
      }
      return restartPrevious(notify, pausedAt, previousWorker.storage);
    }
  }

  return {
    done: completion.promise,
    start(): Promise<void> {
      if (started || stopped) return Promise.reject(new Error($t("lib.managed-supervisor.text_379275d7e9")));
      started = true;
      initial = (async () => {
        await recoverUpdateActivation(root);
        await recoverMigrationPublicationWithHostLock(root);
        await startWorker();
      })().catch((error: unknown) => {
        if (!current && !stopped) completion.resolve(1);
        throw error;
      });
      return initial;
    },
    replace(stage: PreparedUpdate, statePaths?: readonly string[]) {
      if (!current || stopped || transition) return Promise.reject(new Error($t("lib.managed-supervisor.text_8cab0ab013")));
      transition = switchWorker(stage, statePaths && (() => statePaths)).finally(() => { transition = undefined; });
      return transition;
    },
    async stop(signal: StopSignal = "SIGTERM") {
      if (!stopped) {
        stopped = signal;
        reportWorkerReady(false);
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
