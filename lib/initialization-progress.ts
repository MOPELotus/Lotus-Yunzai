import { interactiveTerminalInputActive } from "./terminal-output.ts";
import { formatTerminalLog, terminalColorsEnabled } from "./terminal-log-format.ts";
export interface InitializationProgress {
  readonly stage: string;
  readonly message: string;
  readonly completed?: number;
  readonly total?: number;
  readonly unit?: string;
}
export type InitializationProgressCallback = (event: InitializationProgress) => void;
interface Options {
  readonly isTTY?: boolean;
  readonly write?: (text: string) => unknown;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly heartbeatMs?: number;
  readonly signal?: AbortSignal;
}
const clean = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
const valid = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}
function bytes(value: number) {
  if (value < 1024) return `${Math.floor(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}
/** Terminal redraws are throttled; redirected logs use periodic complete lines. */
export function createInitializationProgress(label = "初始化", options: Options = {}) {
  const tty = options.isTTY ?? process.stderr.isTTY === true;
  const write = options.write ?? ((text: string) => process.stderr.write(text));
  const now = options.now ?? Date.now;
  const interval = options.intervalMs ?? (tty ? 200 : 2000);
  const heartbeat = options.heartbeatMs ?? (tty ? 1000 : 10_000);
  const startedAt = now();
  let current: InitializationProgress | undefined;
  let lastWrite = -Infinity;
  let lastSignature = "";
  let rendered = false;
  let closed = false;
  const output = (text: string) => {
    if (interactiveTerminalInputActive() && text.startsWith("\r\x1b[2K")) {
      text = text.slice(5);
      if (!text) return;
      if (!text.endsWith("\n")) text += "\n";
    }
    try { void Promise.resolve(write(text)).catch(() => undefined); } catch {} };
  function line(event: InitializationProgress) {
    const done = valid(event.completed) ? event.completed : undefined;
    const total = valid(event.total) && event.total > 0 ? event.total : undefined;
    const measured = done !== undefined && total !== undefined;
    const percent = measured ? Math.min(100, Math.floor(Math.min(done, total) / total * 100)) : undefined;
    const bar = tty && percent !== undefined ? `[${"=".repeat(Math.floor(percent / 5))}${" ".repeat(20 - Math.floor(percent / 5))}] ` : "";
    const counts = done === undefined ? "" : event.unit === "bytes"
      ? total === undefined ? bytes(done) : `${bytes(Math.min(done, total))}/${bytes(total)}`
      : total === undefined ? `${Math.floor(done)}${clean(event.unit ?? "项")}` : `${Math.floor(Math.min(done, total))}/${Math.floor(total)}${clean(event.unit ?? "项")}`;
    return formatTerminalLog("info", `[${clean(label)}] ${clean(event.message)}${counts ? ` · ${bar}${percent === undefined ? "" : `${percent}% `}${counts}` : ""} · 已耗时${elapsed(now() - startedAt)}`, { now: new Date(now()), color: tty && terminalColorsEnabled() });
  }
  function render(force = false, pulse = false) {
    if (closed || !current || options.signal?.aborted) return;
    const signature = JSON.stringify(current);
    if (!force && now() - lastWrite < (pulse ? Math.max(heartbeat, interactiveTerminalInputActive() ? 10000 : 0) : Math.max(interval, interactiveTerminalInputActive() ? 2000 : 0))) return;
    if (!force && !pulse && signature === lastSignature) return;
    output(tty ? `\r\x1b[2K${line(current)}` : `${line(current)}\n`);
    rendered = true;
    lastWrite = now();
    lastSignature = signature;
  }
  const timer = setInterval(() => render(false, true), Math.max(100, Math.min(heartbeat, 1000)));
  timer.unref();
  const abort = () => finish("已中止", "warn");
  options.signal?.addEventListener("abort", abort, { once: true });
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    options.signal?.removeEventListener("abort", abort);
    if (tty && rendered) output("\n");
  }
  function finish(message: string, level: "info" | "warn" | "error" = "info") {
    if (closed) return;
    if (tty && rendered) output("\r\x1b[2K");
    output(formatTerminalLog(level, `[${clean(label)}] ${clean(message)} · 耗时${elapsed(now() - startedAt)}`, { now: new Date(now()), color: tty && terminalColorsEnabled(level) }) + "\n");
    rendered = false;
    close();
  }
  return {
    update(event: InitializationProgress) {
      if (closed || options.signal?.aborted) return;
      const changedStage = current?.stage !== event.stage;
      if (changedStage && tty && rendered) { output("\n"); rendered = false; }
      const reached = valid(event.total) && event.total > 0 && valid(event.completed) && event.completed >= event.total;
      const newlyReached = reached && !(current?.stage === event.stage && current?.total === event.total && valid(current.completed) && current.completed >= event.total);
      current = event;
      render(changedStage || newlyReached);
    },
    complete(message = "准备完成") { finish(options.signal?.aborted ? "已中止" : message); },
    fail(message = "准备失败") { finish(message, "error"); },
    close,
  };
}

export async function runInitializationStage<T>(message: string, task: (progress: InitializationProgressCallback) => Promise<T>,
  options: Options & { readonly label?: string } = {}): Promise<T> {
  const progress = createInitializationProgress(options.label, options);
  progress.update({ stage: message, message });
  try {
    options.signal?.throwIfAborted();
    const result = await task(progress.update);
    options.signal?.throwIfAborted();
    progress.complete(`${message}完成`);
    return result;
  } catch (error) {
    progress.fail(options.signal?.aborted ? `${message}已中止` : `${message}失败`);
    throw error;
  } finally { progress.close(); }
}
