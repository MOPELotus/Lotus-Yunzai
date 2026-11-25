import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { formatTerminalLog } from "../lib/terminal-log-format.ts";
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
    $t("scripts.run-managed.text_e533bb7ee6"), 0, $t("scripts.run-managed.text_b7751da923"));
  const supervisor = createManagedSupervisor(root, { onWorkerReady, powerState });
  let stopping = false;
  let requestedSignal: "SIGINT" | "SIGTERM" | undefined;
  let reportedInterrupt = false;
  const normalizeStop = (status: number) => {
    if (!requestedSignal || (status !== (requestedSignal === "SIGINT" ? 130 : 143) && status !== 0)) return status;
    if (!reportedInterrupt && !ready) console.info(formatTerminalLog("mark", $t("scripts.run-managed.text_e5a73c676a")));
    reportedInterrupt = true;
    return 0;
  };
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    stopping = true;
    void supervisor.stop(signal);
  };
  const interrupt = () => { if (!stopping) requestedSignal = "SIGINT"; stop("SIGINT"); };
  const terminate = () => { if (!stopping) requestedSignal = "SIGTERM"; stop("SIGTERM"); };
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
        throw new Error($t("scripts.run-managed.text_2ce3fdb802"));
      }
    }
    const status = await supervisor.done;
    return ready && stopping ? 0 : normalizeStop(status);
  } catch (error) {
    const status = started ? await supervisor.done : 1;
    if (requestedSignal && (status === (requestedSignal === "SIGINT" ? 130 : 143) || status === 0)) return normalizeStop(status);
    console.error(error instanceof Error ? error.message : $t("scripts.run-managed.text_07741e2b75"));
    return status || 1;
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
