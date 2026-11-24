import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

const marker = (root: URL) => new URL("data/.initialization-pending.json", root);
export async function beginInitialization(root: URL): Promise<string> {
  await mkdir(new URL("data/", root), { recursive: true, mode: 0o700 });
  const runId = randomUUID();
  const temporary = new URL(`data/.initialization-${runId}.json`, root);
  await writeFile(temporary, JSON.stringify({ format: 1, runId, startedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
  try { await rename(temporary, marker(root)); }
  finally { await rm(temporary, { force: true }); }
  return runId;
}
export async function finishInitialization(root: URL, runId: string): Promise<void> {
  const current = JSON.parse(await readFile(marker(root), "utf8"));
  if (current.runId === runId) await rm(marker(root));
}
export async function assertInitializationComplete(root: URL): Promise<void> {
  const pending = await lstat(marker(root)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (pending) throw new Error("上次完整初始化尚未完成，请重新运行 bun run bootstrap，完成后再启动。");
}
