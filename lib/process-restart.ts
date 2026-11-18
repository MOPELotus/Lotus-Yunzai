import { isAbsolute } from "node:path";

const executable = process.execPath;
const startupDirectory = process.cwd();
const applicationArgs = process.argv.slice(1);
const restartArgs = [executable, ...process.execArgv, ...applicationArgs];

export function canRestartHost(): boolean {
  return typeof process.versions.bun === "string" && process.platform !== "win32" &&
    typeof process.execve === "function" && isAbsolute(executable) && Boolean(applicationArgs[0]);
}

export function restartHost(): never {
  if (!canRestartHost() || !process.execve) throw new Error("当前运行环境不支持进程内重启，需由部署管理器重启。");

  // execve inherits cwd and stdio. Cleanup must already have completed in the caller.
  process.chdir(startupDirectory);
  return process.execve(executable, restartArgs, process.env);
}
