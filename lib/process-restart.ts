import { isAbsolute } from "node:path";

const executable = process.execPath;
const startupDirectory = process.cwd();
const applicationArgs = process.argv.slice(1);
const restartArgs = [executable, ...process.execArgv, ...applicationArgs];
const pausedStateKey = "LOTUS_EXECVE_PAUSED_STATE";

export function readRestartPausedAt(): number | undefined {
  const state = process.env[pausedStateKey];
  delete process.env[pausedStateKey];
  const [, pid, timestamp] = /^(\d+):(\d+)$/u.exec(state ?? "") ?? [];
  const pausedAt = Number(timestamp);
  if (pid === String(process.pid) && Number.isSafeInteger(pausedAt) && pausedAt > 0) {
    return pausedAt;
  }
}

export function canRestartHost(): boolean {
  return typeof process.versions.bun === "string" && process.platform !== "win32" &&
    typeof process.execve === "function" && isAbsolute(executable) && Boolean(applicationArgs[0]);
}

export function restartHost(pausedAt?: number): never {
  if (!canRestartHost() || !process.execve) throw new Error("当前运行环境不支持进程内重启，需由部署管理器重启。");

  // execve inherits cwd and stdio. Cleanup must already have completed in the caller.
  process.chdir(startupDirectory);
  const env = { ...process.env };
  delete env[pausedStateKey];
  if (pausedAt !== undefined) env[pausedStateKey] = `${process.pid}:${pausedAt}`;
  return process.execve(executable, restartArgs, env);
}
