import { realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { createManagedSupervisor } from "../lib/managed-supervisor.ts";

export async function runManaged(directory: string, ready?: () => Promise<void>): Promise<number> {
  const root = await realpath(directory);
  // Keep the same lock across a supervised checkout replacement.
  const lock = await lockFile(join(dirname(root), `.${basename(root)}.lotus-host.sqlite`),
    "托管宿主", 0, "当前目录已有托管宿主运行。");
  const supervisor = createManagedSupervisor(root);
  const interrupt = () => { void supervisor.stop("SIGINT"); };
  const terminate = () => { void supervisor.stop("SIGTERM"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    await supervisor.start();
    if (ready) {
      try {
        await ready();
      } catch {
        await supervisor.stop();
        throw new Error("无法通知 PM2 宿主已就绪。");
      }
    }
    return await supervisor.done;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "托管宿主无法启动。");
    return (await supervisor.done) || 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    lock.close();
  }
}

if (import.meta.main) {
  try {
    const [directory = process.cwd(), readyFile] = process.argv.slice(2);
    process.exitCode = await runManaged(directory, readyFile ? async () => {
      await writeFile(readyFile, String(process.pid), { mode: 0o600 });
      if (process.connected) process.send?.("ready");
    } : undefined);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "托管宿主无法启动。");
    process.exitCode = 1;
  }
}
