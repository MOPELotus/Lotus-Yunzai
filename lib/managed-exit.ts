import { writeFile } from "node:fs/promises";

export const backgroundStartupFailure = 78;
export const backgroundCleanStop = 79;

export async function managedProcess(start: (ready?: () => Promise<void>) => Promise<number>, readyFile?: string) {
  let started = !readyFile;
  try {
    const status = await start(readyFile ? async () => {
      await writeFile(readyFile, String(process.pid), { mode: 0o600 });
      started = true;
      if (process.connected) process.send?.("ready", () => {});
    } : undefined);
    const exit = readyFile && status === backgroundStartupFailure ? 1 : status;
    process.exitCode = started ? exit : backgroundStartupFailure;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "托管宿主无法启动。");
    process.exitCode = started ? 1 : backgroundStartupFailure;
  }
}
