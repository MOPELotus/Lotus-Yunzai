import { constants } from "node:os";
import { isGitRevision } from "./local-git.ts";
import { isManagedPluginDirectory, isManagedUpdateProgress, isManagedUpdateRequestId, isTerminalManagedUpdateProgress, managedUpdateDirectoryLimit, parseManagedUpdateRequest,
  type ManagedUpdateProgress, type ManagedUpdateRequest } from "./managed-update-protocol.ts";

type StopSignal = "SIGINT" | "SIGTERM";

interface ManagedWorkerOptions {
  readonly held?: boolean;
  readonly expectedRevision?: string;
  readonly expectedPlugins?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly pausedAt?: number;
  readonly onRestart?: (pausedAt?: number) => void;
  readonly onUpdate?: (request: ManagedUpdateRequest, report: (status: ManagedUpdateProgress) => void) => void | Promise<void>;
}

const startupTimeout = 10_000;
const gracefulStopTimeout = 10_000;
const startupStopTimeout = 1_000;

function validPause(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function spawnManagedWorker(root: string, options: ManagedWorkerOptions = {}) {
  const { expectedRevision, expectedPlugins = [], held, onRestart, onUpdate, pausedAt } = options;
  if (expectedRevision !== undefined && (!isGitRevision(expectedRevision) || expectedRevision.trim() !== expectedRevision)) {
    throw new Error("宿主启动检查需要完整的 Git 提交号。");
  }
  if (expectedPlugins.length > managedUpdateDirectoryLimit || !expectedPlugins.every(isManagedPluginDirectory)) {
    throw new Error("候选插件目录无效。");
  }

  const token = crypto.randomUUID();
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env), LOTUS_MANAGED_TOKEN: token, LOTUS_MANAGED_HELD: held ? "1" : "0",
  };
  if (validPause(pausedAt)) env.LOTUS_MANAGED_PAUSED_AT = String(pausedAt);
  else delete env.LOTUS_MANAGED_PAUSED_AT;
  const readiness = Promise.withResolvers<void>();
  let ready = false;
  let active = !held;
  let stopping = false;
  let restartRequested = false;
  let pendingUpdate: string | undefined;
  const updateRequests = new Set<string>();
  let startupError: Error | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const processGroup = process.platform !== "win32" && !process.stdin.isTTY;

  const child = Bun.spawn([process.execPath, "run", "--no-orphans", "app.ts"], {
    cwd: root,
    env,
    stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: processGroup,
    ipc(message: unknown) {
      if (stopping || !message || typeof message !== "object" || !("token" in message) || message.token !== token ||
          !("type" in message)) return;
      if (message.type === "lotus-ready" && !ready) {
        const revision = "revision" in message ? message.revision : undefined;
        if (expectedRevision !== undefined && revision !== expectedRevision) {
          startupError = new Error("宿主报告的 Git 提交与预期不符。");
          void stop();
        } else if (revision === undefined || (typeof revision === "string" && isGitRevision(revision) && revision.trim() === revision)) {
          const plugins = "plugins" in message ? message.plugins : undefined;
          if (expectedPlugins.length !== 0 && (!Array.isArray(plugins) || plugins.length > managedUpdateDirectoryLimit ||
              !plugins.every(isManagedPluginDirectory) || !expectedPlugins.every((plugin) => plugins.includes(plugin)))) {
            startupError = new Error("宿主未加载预期的候选插件。");
            void stop();
            return;
          }
          ready = true;
          clearTimeout(startupTimer);
          readiness.resolve();
        }
      } else if (message.type === "lotus-restart" && ready && active && !restartRequested && onRestart) {
        const pausedAt = "pausedAt" in message ? message.pausedAt : undefined;
        if (pausedAt !== undefined && !validPause(pausedAt)) return;
        restartRequested = true;
        try {
          onRestart(pausedAt);
        } catch {
          void stop();
        }
      } else if (message.type === "lotus-update" && ready && active && "requestId" in message && "request" in message) {
        handleUpdate(message.requestId, message.request);
      }
    },
  });

  function sendProgress(requestId: string, status: ManagedUpdateProgress) {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.send({ type: "lotus-update-progress", token, requestId, status });
    } catch {
      // The worker may have disconnected before exiting.
    }
  }

  function handleUpdate(requestId: unknown, body: unknown) {
    if (!isManagedUpdateRequestId(requestId) || updateRequests.has(requestId)) return;
    const request = parseManagedUpdateRequest(body);
    if (!request) return;
    updateRequests.add(requestId);
    if (updateRequests.size > 128) {
      const oldest = updateRequests.values().next().value;
      if (oldest) updateRequests.delete(oldest);
    }
    if (pendingUpdate || restartRequested) {
      sendProgress(requestId, "busy");
      return;
    }
    if (!onUpdate) {
      sendProgress(requestId, "unavailable");
      return;
    }

    const id = requestId;
    pendingUpdate = id;
    function report(status: ManagedUpdateProgress) {
      if (pendingUpdate !== id || !isManagedUpdateProgress(status)) return;
      if (isTerminalManagedUpdateProgress(status)) pendingUpdate = undefined;
      sendProgress(id, status);
    }
    void Promise.resolve().then(() => {
      if (!stopping && child.exitCode === null && child.signalCode === null) return onUpdate(request, report);
    }).catch(() => report("failed"));
  }

  function signalGroup(signal: StopSignal | "SIGKILL") {
    if (processGroup) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The child may already have exited and left no group.
      }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }

  const startupTimer = setTimeout(() => {
    startupError = new Error("等待宿主就绪超时。");
    void stop();
  }, startupTimeout);
  const exited = child.exited.then((code) => {
    stopping = true;
    pendingUpdate = undefined;
    clearTimeout(startupTimer);
    clearTimeout(stopTimer);
    signalGroup("SIGKILL");
    if (!ready) readiness.reject(startupError ?? new Error("宿主在就绪前退出。"));
    const signal = child.signalCode;
    return signal === null ? code : 128 + (typeof signal === "number" ? signal : constants.signals[signal]);
  });

  // A caller may wait for exit without waiting for startup.
  void readiness.promise.catch(() => {});

  function stop(signal: StopSignal = "SIGTERM"): Promise<number> {
    if (!stopping && child.exitCode === null && child.signalCode === null) {
      stopping = true;
      clearTimeout(startupTimer);
      startupError ??= new Error("宿主在就绪前被停止。");
      stopTimer = setTimeout(() => signalGroup("SIGKILL"), ready ? gracefulStopTimeout : startupStopTimeout);
      signalGroup(signal);
    }
    return exited;
  }

  return {
    ready: readiness.promise,
    exited,
    activate() {
      if (!ready || stopping || child.exitCode !== null || child.signalCode !== null) throw new Error("宿主尚未就绪或已退出。");
      if (active) return;
      child.send({ type: "lotus-activate", token });
      active = true;
    },
    stop,
  };
}
