import { spawn } from "node:child_process";

export interface NativeRunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly progress?: (line: string) => void;
}

export async function runNativeCommand(argv: readonly string[], options: NativeRunOptions) {
  options.signal?.throwIfAborted();
  const child = spawn(argv[0]!, [...argv.slice(1)], { cwd: options.cwd, env: options.env,
    stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let timedOut = false, failure: Error | undefined;
  const lines: string[] = [];
  const output: string[] = []; let outputBytes = 0;
  const sanitize = (text: string) => text.replace(/https?:\/\/[^\s'"<>]+/giu, value => {
    try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; }
    catch { return "[URL]"; }
  }).replace(/\x1b\[[0-9;]*[A-Za-z]/gu, "").replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 800);
  const drain = async (stream: NonNullable<typeof child.stdout>, capture = false) => {
    let pending = "";
    for await (const chunk of stream) {
      pending += chunk.toString();
      const complete = pending.split(/[\r\n]/u); pending = complete.pop() ?? "";
      for (const raw of complete) {
        const line = sanitize(raw).trim(); if (!line) continue;
        lines.push(line); if (lines.length > 12) lines.shift();
        if (capture && outputBytes < 1024 * 1024) { output.push(line); outputBytes += line.length; }
        try { options.progress?.(line); } catch {}
      }
      if (pending.length > 8192) pending = pending.slice(-8192);
    }
    if (pending) { lines.push(sanitize(pending)); if (capture && outputBytes < 1024 * 1024) output.push(sanitize(pending)); }
  };
  const stop = () => {
    try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid!, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch {} }
  };
  const closed = new Promise<number>(resolve => {
    child.once("error", error => { failure = error; });
    child.once("close", (code, signal) => resolve(code ?? (signal === "SIGILL" ? 132 : -1)));
  });
  const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 60_000);
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    const [code] = await Promise.all([closed, drain(child.stdout!, true), drain(child.stderr!)]);
    options.signal?.throwIfAborted();
    return { code, timedOut, stdout: output.join("\n"), diagnostic: lines.join("\n").slice(-4000), failure };
  } catch (error) {
    stop();
    await closed;
    throw error;
  } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", stop); }
}
