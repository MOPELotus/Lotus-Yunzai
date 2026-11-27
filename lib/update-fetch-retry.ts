import { setTimeout as pause } from "node:timers/promises";
import { runUpdateProcess } from "./update-build.ts";

export { retryableGitFetchFailure } from "./git-network-errors.ts";
import { retryableGitFetchFailure } from "./git-network-errors.ts";

export async function runUpdateFetch(
  directory: string,
  env: NodeJS.ProcessEnv,
  command: string[],
  signal?: AbortSignal,
  options?: {
    run?: typeof runUpdateProcess;
    pause?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  },
): Promise<boolean> {
  signal?.throwIfAborted();
  const run = options?.run ?? runUpdateProcess;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    let rejectAbort!: (reason?: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      let diagnostic: { code: number; timedOut: boolean; stderr: string } | undefined;
      let success: boolean;
      try {
        success = await Promise.race([
          run(directory, env, command, 15000, signal, result => { diagnostic = result; }),
          aborted,
        ]);
      } catch {
        signal?.throwIfAborted();
        return false;
      }
      signal?.throwIfAborted();
      if (success) return true;
      if (attempt === 2 || !diagnostic ||
          !retryableGitFetchFailure(diagnostic.stderr, diagnostic.timedOut)) return false;
      const ms = attempt === 0 ? 400 : 1000;
      await Promise.race([
        options?.pause ? options.pause(ms, signal) : pause(ms, undefined, { signal }),
        aborted,
      ]);
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
  return false;
}
