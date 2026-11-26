import { setTimeout as pause } from "node:timers/promises";
import { runUpdateProcess } from "./update-build.ts";

export function retryableGitFetchFailure(stderr: string, timedOut = false): boolean {
  if (/authentication failed|permission denied|repository not found|couldn't find remote ref|invalid refspec|not (?:a )?git repository|corrupt object|bad object/i.test(stderr)) return false;
  return timedOut || /ECONNRESET|connection (?:reset|refused|closed)|remote end hung up|(?:TLS|SSL|gnutls)[^\r\n]*(?:handshake|connection[^\r\n]*non-properly terminated)|could not resolve host|failed to connect|time[ -]?out|timed out|early EOF|curl\s*(?::\s*)?\(?\s*(?:18|28|35|52|56|92)\b|(?:HTTP(?:\/[\d.]+)?|returned error:|status(?: code)?)[^\r\n]*?\b(?:429|5\d{2})\b/i.test(stderr);
}

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
