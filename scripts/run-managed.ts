import { realpath } from "node:fs/promises";
import { lockFile, managedHostLockPath } from "../lib/file-lock.ts";
import { serveForegroundControl } from "../lib/foreground-control.ts";
import { managedProcess } from "../lib/managed-exit.ts";

export async function runManaged(directory: string, ready?: () => Promise<void>,
  onWorkerReady?: (ready: boolean) => void,
  powerState?: { path: string; attempt: string },
): Promise<number> {
  const { createManagedSupervisor } = await import("../lib/managed-supervisor.ts");
  const root = await realpath(directory);
  // Keep the same lock across a supervised checkout replacement.
  const lock = await lockFile(managedHostLockPath(root),
    "托管宿主", 0, "当前目录已有托管宿主运行。");
  const supervisor = createManagedSupervisor(root, { onWorkerReady, powerState });
  let stopping = false;
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    stopping = true;
    void supervisor.stop(signal);
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let closeControl: (() => void) | undefined;
  let started = false;
  try {
    if (!ready) closeControl = await serveForegroundControl(root, terminate);
    started = true;
    await supervisor.start();
    if (ready) {
      try {
        await ready();
      } catch {
        await supervisor.stop();
        throw new Error("无法通知 PM2 宿主已就绪。");
      }
    }
    const status = await supervisor.done;
    return ready && stopping ? 0 : status;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "托管宿主无法启动。");
    return started ? (await supervisor.done) || 1 : 1;
  } finally {
    closeControl?.();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    lock.close();
  }
}

if (import.meta.main) {
  const [directory = process.cwd(), readyFile] = process.argv.slice(2);
  await managedProcess(ready => runManaged(directory, ready), readyFile);
}
