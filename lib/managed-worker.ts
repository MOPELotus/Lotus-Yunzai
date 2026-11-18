import { constants } from "node:os";
import { isGitRevision } from "./local-git.ts";

type StopSignal = "SIGINT" | "SIGTERM";

interface ManagedWorkerOptions {
  readonly held?: boolean;
  readonly expectedRevision?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly pausedAt?: number;
  readonly onRestart?: (pausedAt?: number) => void;
}

const startupTimeout = 10_000;
const gracefulStopTimeout = 10_000;
const startupStopTimeout = 1_000;

function validPause(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function spawnManagedWorker(root: string, options: ManagedWorkerOptions = {}) {
  const { expectedRevision, held, onRestart, pausedAt } = options;
  if (expectedRevision !== undefined && (!isGitRevision(expectedRevision) || expectedRevision.trim() !== expectedRevision)) {
    throw new Error("宿主启动检查需要完整的 Git 提交号。");
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
      }
    },
  });

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
