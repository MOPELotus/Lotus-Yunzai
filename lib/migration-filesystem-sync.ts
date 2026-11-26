import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";

export async function prepareMigrationFilesystemSync(path: string, signal?: AbortSignal, failure?: () => Error) {
  if (process.platform !== "linux") return;
  const executable = Bun.which("sync", { PATH: process.env.PATH });
  if (!executable) return;
  const flush = async () => {
    signal?.throwIfAborted();
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, ["-f", "/proc/self/fd/3"], {
          stdio: ["ignore", "ignore", "ignore", directory.fd], signal,
        });
        child.once("error", reject);
        child.once("exit", code => code === 0 ? resolve() : reject(failure?.() ?? Object.assign(new Error("EIO"), { code: "EIO" })));
      });
    } finally { await directory.close(); }
    signal?.throwIfAborted();
  };
  try { await flush(); return flush; }
  catch { signal?.throwIfAborted(); return; }
}
